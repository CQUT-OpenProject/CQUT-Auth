create extension if not exists pg_cron;

create index if not exists idx_oidc_artifacts_expires_at
on oidc_artifacts (expires_at);

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
