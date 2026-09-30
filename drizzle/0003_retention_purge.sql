ALTER TABLE "contracts" ADD COLUMN "documents_purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storage_objects" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
-- Audit rows stay append-only. The only permitted DELETE is the retention job purging an ENTIRE contract chain after the
-- audit-retention period, which it signals with a transaction-local setting. UPDATE and TRUNCATE remain blocked for everyone.
CREATE OR REPLACE FUNCTION esign_audit_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('esign.audit_purge', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% on % is not permitted (append-only evidence)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER audit_events_no_update ON audit_events;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION esign_audit_guard();
