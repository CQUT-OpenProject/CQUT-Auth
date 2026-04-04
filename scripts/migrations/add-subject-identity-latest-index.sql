create index if not exists idx_subject_identities_subject_id_updated_at_desc
on subject_identities (subject_id, updated_at desc);
