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
  display_name text not null,
  description text not null default '',
  owner_subject_id text references subjects(subject_id),
  client_type text not null check (client_type in ('web', 'spa')),
  auto_consent boolean not null default false,
  lifecycle_status text not null default 'draft' check (lifecycle_status in ('draft', 'active', 'disabled')),
  active_revision_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0)
);

create table if not exists oidc_client_revisions (
  revision_id bigserial primary key,
  client_id text not null references oidc_clients(client_id),
  revision_number integer not null check (revision_number > 0),
  review_status text not null check (review_status in ('draft', 'pending', 'approved', 'rejected')),
  redirect_uris jsonb not null,
  post_logout_redirect_uris jsonb not null default '[]'::jsonb,
  scope_whitelist jsonb not null,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (client_id, revision_number),
  unique (client_id, revision_id)
);

do $$ begin
  alter table oidc_clients
    add constraint fk_oidc_clients_active_revision
    foreign key (client_id, active_revision_id)
    references oidc_client_revisions(client_id, revision_id);
exception when duplicate_object then null;
end $$;

create unique index if not exists uq_oidc_client_revisions_open
on oidc_client_revisions (client_id)
where review_status in ('draft', 'pending');

create index if not exists idx_oidc_clients_owner_updated
on oidc_clients (owner_subject_id, updated_at desc);

create index if not exists idx_oidc_clients_status_updated
on oidc_clients (lifecycle_status, updated_at desc);

create index if not exists idx_oidc_client_revisions_review_updated
on oidc_client_revisions (review_status, updated_at desc);

create table if not exists oidc_client_audit_logs (
  id bigserial primary key,
  client_id text not null,
  revision_id bigint,
  revision_number integer,
  actor_subject_id text,
  action text not null,
  changed_fields jsonb not null default '[]'::jsonb,
  previous_client_status text,
  new_client_status text,
  previous_revision_status text,
  new_revision_status text,
  reason text,
  source_ip text,
  created_at timestamptz not null default now()
);

create index if not exists idx_oidc_client_audit_logs_client_created
on oidc_client_audit_logs (client_id, created_at desc);

create table if not exists management_sessions (
  token_hash text primary key,
  subject_id text not null references subjects(subject_id),
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at timestamptz not null
);

create index if not exists idx_management_sessions_expires_at
on management_sessions (expires_at);

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
