import { UsageLedger } from "../../dist/usage.js";
const ledger=new UsageLedger(process.argv[2]);
ledger.setLimitProvider(()=>150);
await ledger.reserve("primary","fixture",50,100);
process.exit(17);
