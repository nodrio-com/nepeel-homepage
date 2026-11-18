begin;

-- A post has no public link until its author chooses to share it.
create table public.post_share_links (
  post_id uuid primary key references public.posts(id) on delete cascade,
  token text unique not null default translate(
    encode(sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())), 'base64'),
    '+/=', '-_'
  ) check (token ~ '^[A-Za-z0-9_-]{43}$')
);
alter table public.post_share_links enable row level security;
revoke all on public.post_share_links from public, anon, authenticated;

create function public.set_post_share_link(p_post uuid, p_enabled boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare current_token text;
begin
  -- Serialize issue, revoke and post deletion, including concurrent first shares.
  perform 1 from public.posts where id = p_post and user_id = auth.uid() for update;
  if not found then raise exception 'Post unavailable' using errcode = '42501'; end if;
  if p_enabled is null then raise exception 'Share setting required'; end if;
  if not p_enabled then
    delete from public.post_share_links where post_id = p_post;
    return null;
  end if;
  select token into current_token from public.post_share_links where post_id = p_post;
  if not found then
    insert into public.post_share_links(post_id) values (p_post) returning token into current_token;
  end if;
  return current_token;
end;
$$;

-- The web function receives only the fields used on the recipient's page.
create function public.resolve_post_share(p_token text)
returns table (image_path text, caption text, mime_type text)
language sql stable security definer set search_path = '' as $$
  select p.image_path, p.caption, lower(o.metadata->>'mimetype')
  from public.post_share_links l
  join public.posts p on p.id = l.post_id
  join storage.objects o on o.bucket_id = 'captures' and o.name = p.image_path
  where l.token = p_token;
$$;

revoke all on function public.set_post_share_link(uuid,boolean), public.resolve_post_share(text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_post_share_link(uuid,boolean) to authenticated;
grant execute on function public.resolve_post_share(text) to service_role;
commit;
