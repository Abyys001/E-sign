-- Retention may blank/truncate the IP of an access event; nothing else on the row may ever change.
CREATE OR REPLACE FUNCTION esign_guard_access_event() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'ip') IS DISTINCT FROM (to_jsonb(OLD) - 'ip') THEN
    RAISE EXCEPTION 'UPDATE on % may only change ip (append-only)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS intake_access_events_no_update ON intake_access_events;--> statement-breakpoint
CREATE TRIGGER intake_access_events_guard BEFORE UPDATE ON intake_access_events FOR EACH ROW EXECUTE FUNCTION esign_guard_access_event();
