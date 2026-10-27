/// Stands in for the Workers runtime's `cloudflare:workers` module in Node.
/// The OAuth library only uses WorkerEntrypoint to tell a class-style handler
/// from an object-style one; this worker passes objects, so an empty class is
/// the whole of what is needed.
export class WorkerEntrypoint {}
