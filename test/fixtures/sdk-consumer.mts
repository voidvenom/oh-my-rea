import {createRuntime, type RuntimeResult, type ExecutionObservation, type ResourceLimits} from "oh-my-rea/sdk";
export async function consumer(directory: string): Promise<RuntimeResult> {
  const limits: Partial<ResourceLimits> = {model: 2};
  void limits;
  const runtime = await createRuntime({cwd: directory, sessionsRootDir: directory, noModel: true});
  const stop = runtime.onEvent((event: ExecutionObservation) => {void event.event.seq;});
  try {const result: RuntimeResult = await runtime.command("/state get");await runtime.readEvents({afterSeq:0,limit:10});await runtime.snapshot();return result;}
  finally {stop();await runtime.close();}
}
