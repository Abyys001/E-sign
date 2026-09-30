import { CORE, BOILERPLATE } from "./core";
import { TICKETING } from "./ticketing";
import { SERVICES } from "./services";
import { LEGAL } from "./legal";
import type { SeedClause } from "../types";

export const SEED_CLAUSES: SeedClause[] = [...CORE, ...TICKETING, ...SERVICES, ...LEGAL, ...BOILERPLATE];
