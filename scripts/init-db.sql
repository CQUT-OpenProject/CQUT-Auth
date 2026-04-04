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
  grant_id text,
  uid text,
  user_code text,
  client_id text,
  subject_id text,
  payload jsonb not null,
  expires_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_oidc_artifacts_kind_expires_at
on oidc_artifacts (kind, expires_at);

create index if not exists idx_oidc_artifacts_expires_at
on oidc_artifacts (expires_at);

create index if not exists idx_oidc_artifacts_uid
on oidc_artifacts (uid);

create index if not exists idx_oidc_artifacts_user_code
on oidc_artifacts (user_code);

create index if not exists idx_oidc_artifacts_grant_id
on oidc_artifacts (grant_id);

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
    'delete from oidc_artifacts where expires_at is not null and expires_at <= now()'
  );
end
$$;
