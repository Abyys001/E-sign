# Graph Report - .  (2026-09-29)

## Corpus Check
- 250 files · ~168,277 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1676 nodes · 4116 edges · 88 communities (82 shown, 6 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 70 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_API Route Helpers|API Route Helpers]]
- [[_COMMUNITY_PDF Processing|PDF Processing]]
- [[_COMMUNITY_Rate Limiting & DB|Rate Limiting & DB]]
- [[_COMMUNITY_Platform Docs|Platform Docs]]
- [[_COMMUNITY_Contract Service|Contract Service]]
- [[_COMMUNITY_Sign Flow UI|Sign Flow UI]]
- [[_COMMUNITY_Dashboard i18n (en)|Dashboard i18n (en)]]
- [[_COMMUNITY_Dashboard i18n (fa)|Dashboard i18n (fa)]]
- [[_COMMUNITY_Developers i18n (en)|Developers i18n (en)]]
- [[_COMMUNITY_Developers i18n (fa)|Developers i18n (fa)]]
- [[_COMMUNITY_Client Hooks|Client Hooks]]
- [[_COMMUNITY_UI Pages & Buttons|UI Pages & Buttons]]
- [[_COMMUNITY_DB Schema|DB Schema]]
- [[_COMMUNITY_Recipient Modal|Recipient Modal]]
- [[_COMMUNITY_Contract Lifecycle Tasks|Contract Lifecycle Tasks]]
- [[_COMMUNITY_Org Branding & Email Queue|Org Branding & Email Queue]]
- [[_COMMUNITY_Client API & Forms|Client API & Forms]]
- [[_COMMUNITY_Field Validation & Certificate|Field Validation & Certificate]]
- [[_COMMUNITY_Recipient Routing|Recipient Routing]]
- [[_COMMUNITY_Auth Session & RBAC|Auth Session & RBAC]]
- [[_COMMUNITY_Errors & Downloads|Errors & Downloads]]
- [[_COMMUNITY_Members i18n (en)|Members i18n (en)]]
- [[_COMMUNITY_Members i18n (fa)|Members i18n (fa)]]
- [[_COMMUNITY_Audit Export|Audit Export]]
- [[_COMMUNITY_Tests & State Machine|Tests & State Machine]]
- [[_COMMUNITY_Runtime Dependencies|Runtime Dependencies]]
- [[_COMMUNITY_App Shell|App Shell]]
- [[_COMMUNITY_Encryption & Routes|Encryption & Routes]]
- [[_COMMUNITY_Email Rendering|Email Rendering]]
- [[_COMMUNITY_Storage Adapters|Storage Adapters]]
- [[_COMMUNITY_Orgs & Bootstrap|Orgs & Bootstrap]]
- [[_COMMUNITY_Templates|Templates]]
- [[_COMMUNITY_Feedback Components|Feedback Components]]
- [[_COMMUNITY_Contract Detail Tabs|Contract Detail Tabs]]
- [[_COMMUNITY_TS Config|TS Config]]
- [[_COMMUNITY_Account i18n (en)|Account i18n (en)]]
- [[_COMMUNITY_Account i18n (fa)|Account i18n (fa)]]
- [[_COMMUNITY_Worker & Queues|Worker & Queues]]
- [[_COMMUNITY_Webhook Delivery & SSRF|Webhook Delivery & SSRF]]
- [[_COMMUNITY_Crypto & Env|Crypto & Env]]
- [[_COMMUNITY_Elevation & Webhook Secrets|Elevation & Webhook Secrets]]
- [[_COMMUNITY_Dev Dependencies|Dev Dependencies]]
- [[_COMMUNITY_TOTP 2FA|TOTP 2FA]]
- [[_COMMUNITY_Field Preparation|Field Preparation]]
- [[_COMMUNITY_Nav i18n (en)|Nav i18n (en)]]
- [[_COMMUNITY_Nav i18n (fa)|Nav i18n (fa)]]
- [[_COMMUNITY_Locale Layout|Locale Layout]]
- [[_COMMUNITY_Audit i18n (en)|Audit i18n (en)]]
- [[_COMMUNITY_Audit i18n (fa)|Audit i18n (fa)]]
- [[_COMMUNITY_Finalize & Logger|Finalize & Logger]]
- [[_COMMUNITY_SMS Delivery|SMS Delivery]]
- [[_COMMUNITY_Package Metadata|Package Metadata]]
- [[_COMMUNITY_NPM Scripts|NPM Scripts]]
- [[_COMMUNITY_Event Names (en)|Event Names (en)]]
- [[_COMMUNITY_Event Names (fa)|Event Names (fa)]]
- [[_COMMUNITY_Evidence Hashing|Evidence Hashing]]
- [[_COMMUNITY_Event Types (en)|Event Types (en)]]
- [[_COMMUNITY_Event Types (fa)|Event Types (fa)]]
- [[_COMMUNITY_Email Events & Notifications|Email Events & Notifications]]
- [[_COMMUNITY_Webhook Events (en)|Webhook Events (en)]]
- [[_COMMUNITY_Webhook Events (fa)|Webhook Events (fa)]]
- [[_COMMUNITY_Elevate Dialog (en)|Elevate Dialog (en)]]
- [[_COMMUNITY_Notifications i18n (en)|Notifications i18n (en)]]
- [[_COMMUNITY_Elevate Dialog (fa)|Elevate Dialog (fa)]]
- [[_COMMUNITY_Notifications i18n (fa)|Notifications i18n (fa)]]
- [[_COMMUNITY_Field Overlay|Field Overlay]]
- [[_COMMUNITY_Signature Capture|Signature Capture]]
- [[_COMMUNITY_App Layout|App Layout]]
- [[_COMMUNITY_OpenAPI Generator|OpenAPI Generator]]
- [[_COMMUNITY_Status Badge|Status Badge]]
- [[_COMMUNITY_i18n Usage Test|i18n Usage Test]]
- [[_COMMUNITY_Delivery Status (en)|Delivery Status (en)]]
- [[_COMMUNITY_Delivery Status (fa)|Delivery Status (fa)]]
- [[_COMMUNITY_Bilit Brand Logo|Bilit Brand Logo]]
- [[_COMMUNITY_Email Logo|Email Logo]]
- [[_COMMUNITY_Static Logo|Static Logo]]
- [[_COMMUNITY_Brand Mark 512|Brand Mark 512]]
- [[_COMMUNITY_Next Config & CSP|Next Config & CSP]]
- [[_COMMUNITY_Repository Metadata|Repository Metadata]]
- [[_COMMUNITY_Apple Icon|Apple Icon]]
- [[_COMMUNITY_Favicon|Favicon]]
- [[_COMMUNITY_E-Sign Logo GIF|E-Sign Logo GIF]]
- [[_COMMUNITY_DB Migrate|DB Migrate]]

## God Nodes (most connected - your core abstractions)
1. `audit()` - 58 edges
2. `Db` - 54 edges
3. `authed()` - 53 edges
4. `cn()` - 45 edges
5. `developers` - 41 edges
6. `developers` - 41 edges
7. `AppError` - 41 edges
8. `body()` - 37 edges
9. `tx()` - 33 edges
10. `uuid` - 33 edges

## Surprising Connections (you probably didn't know these)
- `RecipientsTab()` --calls--> `C`  [INFERRED]
  src/app/(app)/contracts/[id]/page.tsx → src/server/signing/certificate.ts
- `MessagesTab()` --calls--> `Td()`  [INFERRED]
  src/app/(app)/contracts/[id]/page.tsx → src/components/ui/table.tsx
- `VersionsTab()` --calls--> `useToast()`  [INFERRED]
  src/app/(app)/contracts/[id]/page.tsx → src/components/ui/toast.tsx
- `VerifyPage()` --calls--> `useApi()`  [INFERRED]
  src/app/(public)/verify/[id]/page.tsx → src/lib/api.ts
- `Signer()` --calls--> `C`  [INFERRED]
  src/components/signing/sign-flow.tsx → src/server/signing/certificate.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Signing evidence integrity mechanisms** — contract_platform_security_evidence_integrity, contract_platform_readme_lifecycle, contract_platform_testing_foundation_test, contract_platform_security_signing_links [INFERRED 0.75]
- **Local development runtime stack** — docker_compose_postgres, docker_compose_mailpit, docker_compose_minio, contract_platform_deployment_first_run, contract_platform_readme_processes [INFERRED 0.75]
- **Documented gaps across reports** — contract_platform_final_implementation_report_limitations, contract_platform_security_known_limits, contract_platform_testing_not_automated, contract_platform_readme_legal_disclaimer [INFERRED 0.75]

## Communities (88 total, 6 thin omitted)

### Community 0 - "API Route Helpers"
Cohesion: 0.08
Nodes (40): B, POST, POST, Create, GET, POST, POST, POST (+32 more)

### Community 1 - "PDF Processing"
Cohesion: 0.07
Nodes (45): assertRelative(), normalizeRotation(), PageGeometry, PdfRect, RelativeRect, toPdfRect(), sha256Bytes(), assertBytesWithinLimit() (+37 more)

### Community 2 - "Rate Limiting & DB"
Cohesion: 0.07
Nodes (33): POST, GET, Db, g, POST, GET, B, POST (+25 more)

### Community 3 - "Platform Docs"
Cohesion: 0.06
Nodes (47): AGENTS.md (Next.js breaking-changes notice), CLAUDE.md (imports AGENTS.md), API guide, API auth (session+CSRF, Bearer API keys), API error format and codes, Idempotency-Key on contract send, openapi.json route inventory, Standard Webhooks delivery and events (+39 more)

### Community 4 - "Contract Service"
Cohesion: 0.12
Nodes (42): Actor, addRecipient(), assertEditable(), createContract(), duplicateContract(), lockContract(), nextReference(), reassignRecipient() (+34 more)

### Community 5 - "Sign Flow UI"
Cohesion: 0.09
Nodes (33): BORDER, ICON, Party, Row(), family(), imageFileToDataUrl(), isWinAnsi(), renderTextPng() (+25 more)

### Community 6 - "Dashboard i18n (en)"
Cohesion: 0.05
Nodes (42): dashboard, attention, attentionEmpty, completedSeries, declinedRecently, delivery, emails, emailStatus (+34 more)

### Community 7 - "Dashboard i18n (fa)"
Cohesion: 0.05
Nodes (42): dashboard, attention, attentionEmpty, completedSeries, declinedRecently, delivery, emails, emailStatus (+34 more)

### Community 8 - "Developers i18n (en)"
Cohesion: 0.05
Nodes (39): developers, addKey, addWebhook, apiKeys, apiKeysSub, attempts, deleteDesc, deleteTitle (+31 more)

### Community 9 - "Developers i18n (fa)"
Cohesion: 0.05
Nodes (39): developers, addKey, addWebhook, apiKeys, apiKeysSub, attempts, deleteDesc, deleteTitle (+31 more)

### Community 10 - "Client Hooks"
Cohesion: 0.12
Nodes (28): AccountPage(), ElevationProvider(), useElevation(), useMe(), Topbar(), AuditPage(), useAuditLabel(), ContractsInner() (+20 more)

### Community 11 - "UI Pages & Buttons"
Cohesion: 0.13
Nodes (26): Ctx, E, GROUPS, Page, Row, SORTS, STATUSES, Delivery (+18 more)

### Community 12 - "DB Schema"
Cohesion: 0.05
Nodes (34): apiKeys, auditEvents, completionCertificates, consents, contracts, contractStatus, contractVersions, downloads (+26 more)

### Community 13 - "Recipient Modal"
Cohesion: 0.08
Nodes (31): blank(), Form, RecipientDto, RecipientModal(), FieldEditor(), Props, acceptsDefault(), DEFAULT_SIZE (+23 more)

### Community 14 - "Contract Lifecycle Tasks"
Cohesion: 0.13
Nodes (32): actionableNow(), actionableRecipient(), archiveContract(), cancelContract(), Contract, CreateContractInput, EDITABLE, expireContract() (+24 more)

### Community 15 - "Org Branding & Email Queue"
Cohesion: 0.10
Nodes (29): liveRecipients, checkRecipientAuth(), enqueue(), queueEmail(), queueSms(), smsAvailable(), newOtp(), inviteMember() (+21 more)

### Community 16 - "Client API & Forms"
Cohesion: 0.11
Nodes (21): api(), ApiError, csrf(), errMsg(), fmtNum(), Opts, ContractRow, Role (+13 more)

### Community 17 - "Field Validation & Certificate"
Cohesion: 0.08
Nodes (27): bad(), Base, conditionHolds(), ConditionSchema, decimalPlaces(), Field, FieldInput, FieldType (+19 more)

### Community 18 - "Recipient Routing"
Cohesion: 0.11
Nodes (26): blockedBy(), everyoneRequiredSigned(), isActingRow(), live(), planIssues(), ROLE_TO_KIT, Row, STATUS_TO_KIT (+18 more)

### Community 19 - "Auth Session & RBAC"
Cohesion: 0.13
Nodes (23): DELETE, GET, POST, apiKeyAuth(), AuthContext, checkCsrf(), destroySession(), hashForLog() (+15 more)

### Community 20 - "Errors & Downloads"
Cohesion: 0.12
Nodes (17): GET, GET, DELETE, POST, GET, GET, PUT, loadVersionBytes() (+9 more)

### Community 21 - "Members i18n (en)"
Cohesion: 0.07
Nodes (27): members, changeRole, empty, invite, inviteSent, inviteTitle, lastActive, remove (+19 more)

### Community 22 - "Members i18n (fa)"
Cohesion: 0.07
Nodes (27): members, changeRole, empty, invite, inviteSent, inviteTitle, lastActive, remove (+19 more)

### Community 23 - "Audit Export"
Cohesion: 0.12
Nodes (19): Q, contractFilters(), escapeLike(), listContracts(), ListParams, ListQuery, SORTS, GET (+11 more)

### Community 24 - "Tests & State Machine"
Cohesion: 0.13
Nodes (16): assertTransition(), canTransition(), ContractStatus, inFlight, InvalidTransitionError, STATUSES, T, terminalOps (+8 more)

### Community 25 - "Runtime Dependencies"
Cohesion: 0.08
Nodes (26): dependencies, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @cantoo/pdf-lib, clsx, drizzle-orm, jose, lucide-react (+18 more)

### Community 26 - "App Shell"
Cohesion: 0.11
Nodes (13): LocaleSwitch(), Ctx, Me, MeProvider(), Frame(), NAV, OrgSwitcher(), Sidebar() (+5 more)

### Community 27 - "Encryption & Routes"
Cohesion: 0.13
Nodes (20): GET, PATCH, GET, encrypt(), listUserOrgs(), Deep, isObj(), merge() (+12 more)

### Community 28 - "Email Rendering"
Cohesion: 0.16
Nodes (23): brandFor(), buildMessageVars(), BUTTON_LABEL, deliverEmail(), loadTemplate(), logo(), message(), QueueEmailInput (+15 more)

### Community 29 - "Storage Adapters"
Cohesion: 0.17
Nodes (7): isSafeKey(), LocalStorage, PutResult, StorageProvider, S3Config, S3Storage, toBuffer()

### Community 30 - "Orgs & Bootstrap"
Cohesion: 0.13
Nodes (19): POST, GET, POST, ask(), main(), acceptUserToken(), addMember(), assertMember() (+11 more)

### Community 31 - "Templates"
Cohesion: 0.12
Nodes (19): GET, DELETE, GET, Locale, POST, PUT, previewVars(), ALL_VARS (+11 more)

### Community 32 - "Feedback Components"
Cohesion: 0.17
Nodes (14): Dash, DashboardPage(), ek(), N, NotificationsPage(), Card(), CardHeader(), PageHeader() (+6 more)

### Community 33 - "Contract Detail Tabs"
Cohesion: 0.11
Nodes (14): Audit, done(), FieldRow, MessagesTab(), OPEN, Overview(), RecipientsTab(), TabId (+6 more)

### Community 34 - "TS Config"
Cohesion: 0.10
Nodes (20): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+12 more)

### Community 35 - "Account i18n (en)"
Cohesion: 0.10
Nodes (20): account, code, confirmPassword, disable, disabled, elevate, elevated, elevateHint (+12 more)

### Community 36 - "Account i18n (fa)"
Cohesion: 0.10
Nodes (20): account, code, confirmPassword, disable, disabled, elevate, elevated, elevateHint (+12 more)

### Community 37 - "Worker & Queues"
Cohesion: 0.16
Nodes (16): Tx, g, getBoss(), QueueName, QUEUES, RETRY, stopBoss(), retentionDays() (+8 more)

### Community 38 - "Webhook Delivery & SSRF"
Cohesion: 0.16
Nodes (16): deliverWebhook(), DeliveryResult, post(), redeliver(), resolveTarget(), assertPublicHttpsUrl(), BLOCKED_V4, isBlockedAddress() (+8 more)

### Community 39 - "Crypto & Env"
Cohesion: 0.18
Nodes (16): createSession(), secure(), sessionHash(), env, hex32, schema, inboundEventsSecret(), deriveSigningToken() (+8 more)

### Community 40 - "Elevation & Webhook Secrets"
Cohesion: 0.15
Nodes (12): POST, own(), POST, requireElevation(), DELETE, Patch, newWebhookSecret(), WEBHOOK_EVENTS (+4 more)

### Community 41 - "Dev Dependencies"
Cohesion: 0.12
Nodes (16): devDependencies, drizzle-kit, eslint, eslint-config-next, @playwright/test, tsx, @types/node, @types/nodemailer (+8 more)

### Community 42 - "TOTP 2FA"
Cohesion: 0.21
Nodes (11): hasActiveTotp(), newTotpSecret(), sealTotp, totpUri(), verifyTotp(), POST, Body, POST (+3 more)

### Community 43 - "Field Preparation"
Cohesion: 0.14
Nodes (14): BASE_KEYS, FIELD_TYPES, FieldDto, FieldPayload, FieldTypeName, isWinAnsi(), PreparedField, prepareField() (+6 more)

### Community 44 - "Nav i18n (en)"
Cohesion: 0.13
Nodes (15): nav, account, audit, contracts, dashboard, developers, members, menu (+7 more)

### Community 45 - "Nav i18n (fa)"
Cohesion: 0.13
Nodes (15): nav, account, audit, contracts, dashboard, developers, members, menu (+7 more)

### Community 46 - "Locale Layout"
Cohesion: 0.21
Nodes (11): gsf, metadata, RootLayout(), vazir, viewport, AppLocale, dirOf(), LOCALES (+3 more)

### Community 47 - "Audit i18n (en)"
Cohesion: 0.14
Nodes (14): audit, actor, contract, empty, event, export, filter, ip (+6 more)

### Community 48 - "Audit i18n (fa)"
Cohesion: 0.14
Nodes (14): audit, actor, contract, empty, event, export, filter, ip (+6 more)

### Community 49 - "Finalize & Logger"
Cohesion: 0.20
Nodes (11): appUrl(), randomId(), emit(), Level, log, order, scrub(), FieldRow (+3 more)

### Community 50 - "SMS Delivery"
Cohesion: 0.22
Nodes (11): deliverSms(), fill(), QueueSmsInput, SMS_TEXT, SmsNotConfiguredError, SmsProvider, smsProviderFor(), TwilioProvider (+3 more)

### Community 51 - "Package Metadata"
Cohesion: 0.14
Nodes (13): author, bugs, url, description, directories, doc, homepage, keywords (+5 more)

### Community 52 - "NPM Scripts"
Cohesion: 0.15
Nodes (13): scripts, bootstrap, build, db:generate, db:migrate, dev, lint, openapi (+5 more)

### Community 53 - "Event Names (en)"
Cohesion: 0.17
Nodes (12): eventNames, contract_cancelled, contract_completed, contract_created, contract_declined, contract_expired, contract_sent, contract_signed (+4 more)

### Community 54 - "Event Names (fa)"
Cohesion: 0.17
Nodes (12): eventNames, contract_cancelled, contract_completed, contract_created, contract_declined, contract_expired, contract_sent, contract_signed (+4 more)

### Community 55 - "Evidence Hashing"
Cohesion: 0.27
Nodes (9): entryHash(), canonicalJson(), assertEvidence(), AuthLevel, evidenceHash(), hashesDocument(), sha256Hex(), SignatureEvidence (+1 more)

### Community 56 - "Event Types (en)"
Cohesion: 0.20
Nodes (10): types, contract_awaiting_signature, contract_cancelled, contract_completed, contract_declined, contract_expired, contract_signed, contract_viewed (+2 more)

### Community 57 - "Event Types (fa)"
Cohesion: 0.20
Nodes (10): types, contract_awaiting_signature, contract_cancelled, contract_completed, contract_declined, contract_expired, contract_signed, contract_viewed (+2 more)

### Community 58 - "Email Events & Notifications"
Cohesion: 0.27
Nodes (7): EmailEventType, isUuid(), recordEmailEvent(), listNotifications(), NotificationType, unreadCount(), GET

### Community 59 - "Webhook Events (en)"
Cohesion: 0.22
Nodes (9): events, contract_completed, contract_declined, contract_sent, contract_status_cancelled, contract_status_expired, contract_status_voided, document_viewed (+1 more)

### Community 60 - "Webhook Events (fa)"
Cohesion: 0.22
Nodes (9): events, contract_completed, contract_declined, contract_sent, contract_status_cancelled, contract_status_expired, contract_status_voided, document_viewed (+1 more)

### Community 61 - "Elevate Dialog (en)"
Cohesion: 0.29
Nodes (6): elevate, confirm, desc, password, title, totp

### Community 62 - "Notifications i18n (en)"
Cohesion: 0.29
Nodes (7): notifications, empty, emptyUnread, markAll, sub, title, unreadOnly

### Community 63 - "Elevate Dialog (fa)"
Cohesion: 0.29
Nodes (6): elevate, confirm, desc, password, title, totp

### Community 64 - "Notifications i18n (fa)"
Cohesion: 0.29
Nodes (7): notifications, empty, emptyUnread, markAll, sub, title, unreadOnly

### Community 65 - "Field Overlay"
Cohesion: 0.29
Nodes (3): FieldOverlayItem, Props, RelativeRect

### Community 66 - "Signature Capture"
Cohesion: 0.29
Nodes (4): DEFAULT_LABELS, Props, SignatureMode, SignatureValue

### Community 67 - "App Layout"
Cohesion: 0.47
Nodes (4): AppLayout(), Home(), AppShell(), currentAuth()

### Community 68 - "OpenAPI Generator"
Cohesion: 0.33
Nodes (4): Op, paths, root, spec

### Community 69 - "Status Badge"
Cohesion: 0.40
Nodes (3): ContractStatus, DEFAULT_LABEL, TONE

### Community 71 - "Delivery Status (en)"
Cohesion: 0.50
Nodes (4): FAILED, PENDING, SUCCESS, deliveryStatus

### Community 72 - "Delivery Status (fa)"
Cohesion: 0.50
Nodes (4): FAILED, PENDING, SUCCESS, deliveryStatus

### Community 74 - "Bilit Brand Logo"
Cohesion: 1.00
Nodes (3): Bilit.events brand (event ticketing), Bilit.events logo (green ticket-shaped B with gray wordmark), Green ticket-stub B monogram with perforation notches

### Community 75 - "Email Logo"
Cohesion: 1.00
Nodes (3): .events domain suffix in grey, Green ticket-stub glyph forming letter B, Bilit.events wordmark logo (email version)

### Community 76 - "Static Logo"
Cohesion: 1.00
Nodes (3): Bilit.events static logo (green ticket-shaped B mark with grey wordmark), Green ticket-stub B icon with notched edge and music-note cutout, Light grey 'ilit.events' rounded wordmark text

### Community 77 - "Brand Mark 512"
Cohesion: 0.67
Nodes (3): Solid green (#22AD6B-like) on transparent/white background, Bilit brand mark (green ticket-shaped logo with stylized B), Ticket shape with side notch and perforations motif

### Community 79 - "Repository Metadata"
Cohesion: 0.67
Nodes (3): repository, type, url

## Knowledge Gaps
- **809 isolated node(s):** `dashboard`, `contracts`, `templates`, `notifications`, `audit` (+804 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `can()` connect `Auth Session & RBAC` to `API Route Helpers`, `Client Hooks`, `Audit Export`, `Tests & State Machine`, `Encryption & Routes`?**
  _High betweenness centrality (0.086) - this node is a cross-community bridge._
- **Why does `ContractsInner()` connect `Client Hooks` to `Auth Session & RBAC`, `UI Pages & Buttons`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Why does `AuditTab()` connect `Client Hooks` to `Contract Detail Tabs`, `Auth Session & RBAC`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **What connects `dashboard`, `contracts`, `templates` to the rest of the system?**
  _810 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `API Route Helpers` be split into smaller, more focused modules?**
  _Cohesion score 0.0818452380952381 - nodes in this community are weakly interconnected._
- **Should `PDF Processing` be split into smaller, more focused modules?**
  _Cohesion score 0.06557377049180328 - nodes in this community are weakly interconnected._
- **Should `Rate Limiting & DB` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._