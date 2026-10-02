-- Co-parents. A family still has one login (one auth user); inside it there
-- are now up to two parent profiles, each with its own name and PIN, picked
-- from the home screen the same way kids pick theirs. The owner profile is
-- the parent who signed up; only they see billing and manage the co-parent
-- (enforced in the app — both parents share the login, so the database can't
-- tell them apart).
--
-- Replaces parent_security (one PIN per account). The old PIN functions are
-- rewritten below to read and write the owner profile, so the app version
-- that's live while this runs keeps working, and stays in step with the new
-- one. parent_security is left in place until the clean-up migration.
create table public.parent_profiles (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 30),
  is_owner        boolean not null default false,
  pin_hash        text,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A removed co-parent keeps their row so history can still show their name.
  removed_at      timestamptz
);

create index parent_profiles_user_id_idx on public.parent_profiles (user_id);
create unique index parent_profiles_one_owner on public.parent_profiles (user_id) where is_owner;
create unique index parent_profiles_one_co_parent on public.parent_profiles (user_id) where not is_owner and removed_at is null;

-- No policies: the browser only reaches this table through the functions
-- below, which never hand back a PIN hash. Same as parent_security.
alter table public.parent_profiles enable row level security;

-- Existing PINs become the owner profile's PIN.
insert into public.parent_profiles (user_id, name, is_owner, pin_hash, failed_attempts, locked_until, updated_at)
select user_id, 'Parent 1', true, pin_hash, failed_attempts, locked_until, updated_at
from public.parent_security;

-- Who approved, rejected, paid out or adjusted. Null on older rows and on
-- anything the app does by itself (missed chores, cycle close-outs).
alter table public.completions        add column actioned_by uuid references public.parent_profiles(id) on delete set null;
alter table public.reward_completions add column actioned_by uuid references public.parent_profiles(id) on delete set null;
alter table public.transactions       add column actioned_by uuid references public.parent_profiles(id) on delete set null;
alter table public.distributions      add column actioned_by uuid references public.parent_profiles(id) on delete set null;

-- ─── helpers ────────────────────────────────────────────────────────

create or replace function public.ensure_owner_profile()
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select id into v_id from public.parent_profiles where user_id = auth.uid() and is_owner;
  if v_id is null then
    insert into public.parent_profiles (user_id, name, is_owner) values (auth.uid(), 'Parent 1', true)
    on conflict do nothing;
    select id into v_id from public.parent_profiles where user_id = auth.uid() and is_owner;
  end if;
  return v_id;
end;
$$;

-- Every profile on the account, removed ones included (for history names).
create or replace function public.get_parent_profiles()
returns table (id uuid, name text, is_owner boolean, has_pin boolean, removed boolean)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
begin
  perform public.ensure_owner_profile();
  return query
    select p.id, p.name, p.is_owner, p.pin_hash is not null, p.removed_at is not null
    from public.parent_profiles p
    where p.user_id = auth.uid()
    order by p.is_owner desc, p.created_at;
end;
$$;

create or replace function public.verify_parent_profile_pin(p_profile_id uuid, p_guess text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_row public.parent_profiles%rowtype;
  v_ok boolean;
begin
  if auth.uid() is null then return false; end if;
  select * into v_row from public.parent_profiles
    where id = p_profile_id and user_id = auth.uid() and removed_at is null;
  if not found or v_row.pin_hash is null then return false; end if;
  if v_row.locked_until is not null and v_row.locked_until > now() then return false; end if;
  v_ok := v_row.pin_hash = extensions.crypt(p_guess, v_row.pin_hash);
  if v_ok then
    update public.parent_profiles set failed_attempts = 0, locked_until = null where id = v_row.id;
  else
    update public.parent_profiles
      set failed_attempts = failed_attempts + 1,
          locked_until = case when failed_attempts + 1 >= 5 then now() + interval '5 minutes' else locked_until end
      where id = v_row.id;
  end if;
  return v_ok;
end;
$$;

create or replace function public.set_parent_profile_pin(p_profile_id uuid, p_new_pin text)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_new_pin !~ '^\d{4}$' then raise exception 'PIN must be exactly 4 digits'; end if;
  update public.parent_profiles
    set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf')),
        failed_attempts = 0, locked_until = null, updated_at = now()
    where id = p_profile_id and user_id = auth.uid() and removed_at is null;
  if not found then raise exception 'parent not found'; end if;
end;
$$;

create or replace function public.rename_parent_profile(p_profile_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  update public.parent_profiles set name = btrim(p_name), updated_at = now()
    where id = p_profile_id and user_id = auth.uid() and removed_at is null;
  if not found then raise exception 'parent not found'; end if;
end;
$$;

-- Adds the co-parent. The owner must already have a PIN, or the app couldn't
-- tell the two parents apart at the PIN screen.
create or replace function public.add_co_parent(p_name text, p_pin text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare v_owner uuid; v_id uuid;
begin
  v_owner := public.ensure_owner_profile();
  if not exists (select 1 from public.parent_profiles where id = v_owner and pin_hash is not null) then
    raise exception 'set your own PIN first';
  end if;
  if p_pin !~ '^\d{4}$' then raise exception 'PIN must be exactly 4 digits'; end if;
  if exists (select 1 from public.parent_profiles where user_id = auth.uid() and not is_owner and removed_at is null) then
    raise exception 'this family already has a co-parent';
  end if;
  insert into public.parent_profiles (user_id, name, is_owner, pin_hash)
    values (auth.uid(), btrim(p_name), false, extensions.crypt(p_pin, extensions.gen_salt('bf')))
    returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.remove_co_parent(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  update public.parent_profiles
    set removed_at = now(), pin_hash = null, failed_attempts = 0, locked_until = null, updated_at = now()
    where id = p_profile_id and user_id = auth.uid() and not is_owner and removed_at is null;
  if not found then raise exception 'co-parent not found'; end if;
end;
$$;

-- ─── the original single-PIN functions, now pointed at the owner profile ──

create or replace function public.has_parent_pin()
returns boolean
language sql
security definer
set search_path to 'public', 'extensions'
as $$
  select exists(select 1 from public.parent_profiles where user_id = auth.uid() and is_owner and pin_hash is not null);
$$;

create or replace function public.set_parent_pin(p_new_pin text)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
begin
  perform public.set_parent_profile_pin(public.ensure_owner_profile(), p_new_pin);
end;
$$;

create or replace function public.verify_parent_pin(p_guess text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
begin
  if auth.uid() is null then return false; end if;
  return public.verify_parent_profile_pin(public.ensure_owner_profile(), p_guess);
end;
$$;

-- Not allowed while there's a co-parent: without PINs the app can't tell
-- which parent is which.
create or replace function public.remove_parent_pin()
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if exists (select 1 from public.parent_profiles where user_id = auth.uid() and not is_owner and removed_at is null) then
    raise exception 'remove the co-parent first';
  end if;
  update public.parent_profiles set pin_hash = null, failed_attempts = 0, locked_until = null, updated_at = now()
    where user_id = auth.uid() and is_owner;
end;
$$;

revoke all on function public.ensure_owner_profile() from public, anon;
revoke all on function public.get_parent_profiles() from public, anon;
revoke all on function public.verify_parent_profile_pin(uuid, text) from public, anon;
revoke all on function public.set_parent_profile_pin(uuid, text) from public, anon;
revoke all on function public.rename_parent_profile(uuid, text) from public, anon;
revoke all on function public.add_co_parent(text, text) from public, anon;
revoke all on function public.remove_co_parent(uuid) from public, anon;
grant execute on function public.ensure_owner_profile() to authenticated;
grant execute on function public.get_parent_profiles() to authenticated;
grant execute on function public.verify_parent_profile_pin(uuid, text) to authenticated;
grant execute on function public.set_parent_profile_pin(uuid, text) to authenticated;
grant execute on function public.rename_parent_profile(uuid, text) to authenticated;
grant execute on function public.add_co_parent(text, text) to authenticated;
grant execute on function public.remove_co_parent(uuid) to authenticated;
