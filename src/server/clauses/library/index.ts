import { CORE, BOILERPLATE } from "./core";
import { TICKETING } from "./ticketing";
import { SERVICES } from "./services";
import { LEGAL } from "./legal";
import { PROMOTER_MASTER, PROMOTER_SCHEDULE } from "./promoter";
import { PROMOTER_GLOBAL } from "./promoter-global";
import type { SeedClause } from "../types";

export const SEED_CLAUSES: SeedClause[] = [...CORE, ...TICKETING, ...SERVICES, ...LEGAL, ...BOILERPLATE, ...PROMOTER_MASTER, ...PROMOTER_SCHEDULE, ...PROMOTER_GLOBAL];
