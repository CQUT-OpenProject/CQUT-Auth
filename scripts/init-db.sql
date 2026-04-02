create table if not exists clients (
  client_id text primary key,
  client_secret_hash text not null,
  allowed_scopes jsonb not null,
  status text not null,
  created_at timestamptz not null default now()
);

create table if not exists verification_requests (
  request_id text primary key,
  client_id text not null,
  scope jsonb not null,
  status text not null,
  verified boolean,
  student_status text,
  school text,
  dedupe_key text,
  internal_identity_hash text,
  error text,
  error_description text,
  created_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null
);

create index if not exists idx_verification_requests_client_created_at
on verification_requests (client_id, created_at desc);

create index if not exists idx_verification_requests_expires_at
on verification_requests (expires_at);

create table if not exists verification_jobs (
  job_id text primary key,
  request_id text not null unique,
  client_id text not null,
  provider text not null,
  payload_ciphertext text,
  status text not null,
  attempt_count integer not null default 0,
  available_at timestamptz not null,
  created_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text
);

create index if not exists idx_verification_jobs_status_available_at
on verification_jobs (status, available_at);
