import { writeFile } from "node:fs/promises";
import { ExecutionStore } from "../../dist/execution.js";
const [directory, effect] = process.argv.slice(2);
const store = new ExecutionStore("crash-fixture", directory);
await store.invoke({backend:"script",tool:"effect",args:{file:effect},readOnly:false,binding:{target:"fixture"}},async()=>{
  await writeFile(effect,"one completed side effect");
  process.exit(17); // Simulates process death after the effect and before result/checkpoint publication.
});
