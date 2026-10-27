import { readPdfText } from "../../src/pdf";
export default {
  async fetch(req: Request): Promise<Response> {
    const pw = new URL(req.url).searchParams.get("pw");
    const bytes = new Uint8Array(await req.arrayBuffer());
    const t0 = Date.now();
    const r = await readPdfText(bytes, pw);
    return Response.json({ ms: Date.now() - t0, ...r });
  },
};
