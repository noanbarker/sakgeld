-- Custom chore photos: a parent can photograph the real bed or the real dog
-- bowl instead of picking one of the 41 illustrations.
--
-- The app compresses every photo to a 512x512 WebP (or JPEG on Safari, which
-- cannot encode WebP from a canvas) before upload, so files land at roughly
-- 20-70 KB. The 2 MB ceiling below is a guard against a broken client, not a
-- working size.

alter table public.chores add column if not exists image_path text;

-- Private bucket. Photos are reached through short-lived signed URLs, never a
-- public URL, because these are pictures taken inside families' homes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chore-photos', 'chore-photos', false, 2097152,
        array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Every object is stored as `<user_id>/<chore_id>-<timestamp>.webp`, so the
-- first path segment is what decides who may touch it. A parent can only ever
-- read or write inside their own folder.
drop policy if exists "chore photos: read own"   on storage.objects;
drop policy if exists "chore photos: insert own" on storage.objects;
drop policy if exists "chore photos: update own" on storage.objects;
drop policy if exists "chore photos: delete own" on storage.objects;

create policy "chore photos: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'chore-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "chore photos: insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chore-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "chore photos: update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'chore-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'chore-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "chore photos: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'chore-photos' and (storage.foldername(name))[1] = auth.uid()::text);
