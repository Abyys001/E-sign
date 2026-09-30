-- Audit log: append-only. UPDATE/DELETE/TRUNCATE are rejected for every role that goes through triggers.
CREATE OR REPLACE FUNCTION esign_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted (append-only evidence)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION esign_reject_mutation();--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION esign_reject_mutation();--> statement-breakpoint
CREATE TRIGGER signatures_no_mutation BEFORE UPDATE OR DELETE ON signatures FOR EACH ROW EXECUTE FUNCTION esign_reject_mutation();--> statement-breakpoint
CREATE TRIGGER consents_no_mutation BEFORE UPDATE OR DELETE ON consents FOR EACH ROW EXECUTE FUNCTION esign_reject_mutation();--> statement-breakpoint
CREATE TRIGGER completion_certificates_no_mutation BEFORE UPDATE OR DELETE ON completion_certificates FOR EACH ROW EXECUTE FUNCTION esign_reject_mutation();--> statement-breakpoint
-- Contract versions: once locked, content columns can never change and the row cannot be deleted.
CREATE OR REPLACE FUNCTION esign_guard_locked_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.locked THEN RAISE EXCEPTION 'locked contract_version % cannot be deleted', OLD.id USING ERRCODE = 'restrict_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.locked AND (NEW.sha256 <> OLD.sha256 OR NEW.storage_object_id <> OLD.storage_object_id OR NEW.locked = false OR NEW.version <> OLD.version OR NEW.kind <> OLD.kind) THEN
    RAISE EXCEPTION 'locked contract_version % is immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER contract_versions_guard BEFORE UPDATE OR DELETE ON contract_versions FOR EACH ROW EXECUTE FUNCTION esign_guard_locked_version();--> statement-breakpoint
-- Fields become read-only (except value/filled_at) once the contract has left DRAFT/READY_TO_SEND.
CREATE OR REPLACE FUNCTION esign_guard_fields() RETURNS trigger AS $$
DECLARE st contract_status;
BEGIN
  SELECT status INTO st FROM contracts WHERE id = COALESCE(NEW.contract_id, OLD.contract_id);
  IF st NOT IN ('DRAFT','READY_TO_SEND') THEN
    IF TG_OP <> 'UPDATE' OR NEW.x <> OLD.x OR NEW.y <> OLD.y OR NEW.w <> OLD.w OR NEW.h <> OLD.h OR NEW.page <> OLD.page
       OR NEW.type <> OLD.type OR NEW.recipient_id <> OLD.recipient_id OR NEW.key <> OLD.key OR NEW.required <> OLD.required THEN
      RAISE EXCEPTION 'field layout is frozen after send' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.filled_at IS NOT NULL AND (NEW.value IS DISTINCT FROM OLD.value OR NEW.filled_at IS DISTINCT FROM OLD.filled_at) THEN
      RAISE EXCEPTION 'filled field value is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER recipient_fields_guard BEFORE INSERT OR UPDATE OR DELETE ON recipient_fields FOR EACH ROW EXECUTE FUNCTION esign_guard_fields();
