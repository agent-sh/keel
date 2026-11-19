// The conformance fixtures are imported as files (their embedded path).
declare module "*.sse" { const path: string; export default path; }
declare module "*.json-array" { const path: string; export default path; }
