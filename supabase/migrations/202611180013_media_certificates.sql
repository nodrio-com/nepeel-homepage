begin;

alter table public.capture_challenges drop constraint capture_challenges_purpose_check;
alter table public.capture_challenges add constraint capture_challenges_purpose_check
  check (purpose in ('register','capture','certify'));

-- Opening the camera can reserve both private and optional social captures.
-- Give private certificates their own bounded allowance.
create or replace function public.issue_challenge(p_user uuid,p_nonce text,p_purpose text)
returns setof public.capture_challenges language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
  delete from public.capture_challenges where user_id=p_user and created_at<now()-interval '1 day';
  if (select count(*) from public.capture_challenges where user_id=p_user
      and created_at>now()-interval '10 minutes'
      and (purpose='certify')=(p_purpose='certify'))>=12 then
    raise exception 'Too many capture requests' using errcode='P0001';
  end if;
  return query insert into public.capture_challenges(user_id,nonce,purpose)
    values(p_user,p_nonce,p_purpose) returning *;
end; $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('certificate-media','certificate-media',false,2097152,array['image/jpeg','video/mp4']);

create table public.media_certificates (
  id uuid primary key,
  challenge_id uuid not null unique,
  user_id uuid not null references public.profiles(id) on delete cascade,
  media_kind text not null check (media_kind in ('photo','video')),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  display_hash text not null check (display_hash ~ '^[0-9a-f]{64}$'),
  salt text not null check (salt ~ '^[0-9a-f]{64}$'),
  commitment text not null unique check (commitment ~ '^[0-9a-f]{64}$'),
  platform text not null check (platform in ('android','ios')),
  object_path text generated always as
    (id::text || case when media_kind='photo' then '/media.jpg' else '/media.mp4' end) stored,
  state text not null default 'uploading' check (state in ('uploading','queued','minted')),
  created_at timestamptz not null default now(),
  share_nonce text,
  share_hash text unique,
  tx_hash text unique,
  tx_blob text,
  last_ledger bigint,
  issuer text,
  token_id text unique,
  lease uuid,
  lease_until timestamptz,
  next_attempt timestamptz not null default now(),
  check ((share_nonce is null) = (share_hash is null)),
  check (share_hash is null or share_hash ~ '^[0-9a-f]{64}$'),
  check (state <> 'minted' or (token_id is not null and issuer is not null and tx_hash is not null))
);
create index certificate_owner_idx on public.media_certificates(user_id,created_at desc);
create index certificate_queue_idx on public.media_certificates(next_attempt) where state='queued';
alter table public.media_certificates enable row level security;
revoke all on public.media_certificates from public,anon,authenticated;
grant all on public.media_certificates to service_role;

-- Retain certificates independently of the short-lived challenge retention job.
create function public.reserve_media_certificate(
  p_challenge uuid,p_user uuid,p_id uuid,p_kind text,p_source_hash text,p_display_hash text,
  p_salt text,p_commitment text,p_platform text,
  p_key text default null,p_previous bigint default null,p_next bigint default null
) returns setof public.media_certificates
language plpgsql security definer set search_path='' as $$
declare r public.media_certificates;
begin
  perform 1 from public.capture_challenges where id=p_challenge and user_id=p_user for update;
  select * into r from public.media_certificates where challenge_id=p_challenge;
  if found then
    if (r.user_id,r.media_kind,r.source_hash,r.platform) is distinct from
       (p_user,p_kind,p_source_hash,p_platform) then raise exception 'Capture content changed'; end if;
    return next r; return;
  end if;
  update public.capture_challenges set used_at=now() where id=p_challenge and user_id=p_user
    and purpose='certify' and used_at is null and expires_at>now();
  if not found then raise exception 'Certificate capture expired or already used'; end if;
  if p_key is not null then
    update public.device_keys set sign_count=p_next
      where key_id=p_key and user_id=p_user and sign_count=p_previous and p_next>sign_count;
    if not found then raise exception 'Invalid assertion counter'; end if;
  end if;
  return query insert into public.media_certificates
    (id,challenge_id,user_id,media_kind,source_hash,display_hash,salt,commitment,platform)
    values(p_id,p_challenge,p_user,p_kind,p_source_hash,p_display_hash,p_salt,p_commitment,p_platform) returning *;
end; $$;

create function public.finish_media_certificate(p_id uuid,p_user uuid)
returns setof public.media_certificates language plpgsql security definer set search_path='' as $$
begin
  update public.media_certificates set state='queued',next_attempt=now()
    where id=p_id and user_id=p_user and state='uploading';
  return query select * from public.media_certificates where id=p_id and user_id=p_user;
end; $$;

-- The issuer owns a single sequence. Persist its signed envelope before sending it.
create function public.lease_certificate_mint()
returns setof public.media_certificates language plpgsql security definer set search_path='' as $$
declare target uuid;
begin
  if not pg_try_advisory_xact_lock(185286628,13) then return; end if;
  if exists(select 1 from public.media_certificates where state='queued' and lease_until>now()) then return; end if;
  select id into target from public.media_certificates where state='queued'
    order by (tx_blob is not null) desc,next_attempt,created_at,id limit 1 for update;
  return query update public.media_certificates set lease=gen_random_uuid(),lease_until=now()+interval '75 seconds'
    where id=target and next_attempt<=now() returning *;
end; $$;

create table public.certificate_cleanup (
  object_path text primary key,
  not_before timestamptz not null default now()+interval '2 minutes'
);
alter table public.certificate_cleanup enable row level security;
revoke all on public.certificate_cleanup from public,anon,authenticated;
grant all on public.certificate_cleanup to service_role;

create function public.queue_certificate_cleanup() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.certificate_cleanup(object_path) values(old.object_path) on conflict do nothing;
  return old;
end; $$;
create trigger certificate_cleanup_on_delete after delete on public.media_certificates
for each row execute function public.queue_certificate_cleanup();
revoke all on function public.reserve_media_certificate,public.finish_media_certificate,
  public.lease_certificate_mint,public.queue_certificate_cleanup from public,anon,authenticated;
grant execute on function public.reserve_media_certificate,public.finish_media_certificate,
  public.lease_certificate_mint to service_role;
commit;
