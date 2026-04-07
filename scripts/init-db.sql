-- Consolidated schema initialization script for OIDC.
-- Legacy auth-service tables are dropped to keep schema consistent on old databases.
drop table if exists verification_jobs;
drop table if exists verification_requests;
drop table if exists clients;

create table if not exists subjects (
  subject_id text primary key,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists subject_identities (
  id bigserial primary key,
  subject_id text not null references subjects(subject_id),
  provider text not null,
  school_uid text not null,
  identity_key text not null,
  current_student_status text,
  school text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, identity_key)
);

create index if not exists idx_subject_identities_subject_id_updated_at_desc
on subject_identities (subject_id, updated_at desc);

create table if not exists subject_profiles (
  subject_id text primary key references subjects(subject_id),
  preferred_username text,
  display_name text,
  email text,
  email_verified boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists oidc_clients (
  client_id text primary key,
  client_secret_hash text,
  application_type text not null,
  token_endpoint_auth_method text not null,
  redirect_uris jsonb not null,
  post_logout_redirect_uris jsonb not null default '[]'::jsonb,
  grant_types jsonb not null,
  response_types jsonb not null,
  scope_whitelist jsonb not null,
  require_pkce boolean not null default true,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists oidc_artifacts (
  id text primary key,
  kind text not null,
  grant_id_hash text,
  uid_hash text,
  user_code_hash text,
  payload jsonb not null,
  expires_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_oidc_artifacts_kind_expires_at
on oidc_artifacts (kind, expires_at);

create index if not exists idx_oidc_artifacts_expires_at
on oidc_artifacts (expires_at);

create index if not exists idx_oidc_artifacts_uid_hash
on oidc_artifacts (uid_hash);

create index if not exists idx_oidc_artifacts_uid_hash_kind
on oidc_artifacts (uid_hash, kind);

create index if not exists idx_oidc_artifacts_user_code_hash
on oidc_artifacts (user_code_hash);

create index if not exists idx_oidc_artifacts_grant_id_hash
on oidc_artifacts (grant_id_hash);

create table if not exists oidc_signing_keys (
  kid text primary key,
  alg text not null,
  use text not null default 'sig',
  public_jwk jsonb not null,
  private_jwk_ciphertext text not null,
  status text not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz
);

create extension if not exists pg_cron;

do $$
declare
  existing_job_id bigint;
begin
  select jobid
    into existing_job_id
  from cron.job
  where jobname = 'oidc_artifacts_expired_cleanup'
  limit 1;

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'oidc_artifacts_expired_cleanup',
    '*/5 * * * *',
    $cleanup$
with doomed as (
  select id
  from oidc_artifacts
  where expires_at is not null and expires_at <= now()
  order by expires_at asc
  limit 5000
)
delete from oidc_artifacts as oa
using doomed
where oa.id = doomed.id
$cleanup$
  );
end
$$;
