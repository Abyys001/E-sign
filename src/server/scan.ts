import net from "node:net";
import { AppError } from "./errors";
import { log } from "./logger";

/** Malware scanning integration point. Configure CLAMAV_HOST[:PORT] to enable clamd scanning of every upload. */
export interface MalwareScanner { readonly name: string; scan(buf: Buffer): Promise<{ clean: boolean; detail?: string }> }

class NoScanner implements MalwareScanner {
  readonly name = "none";
  async scan() { return { clean: true, detail: "no scanner configured" }; }
}

class ClamdScanner implements MalwareScanner {
  readonly name = "clamd";
  constructor(private host: string, private port: number) {}
  scan(buf: Buffer): Promise<{ clean: boolean; detail?: string }> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.port, this.host);
      let out = "";
      sock.setTimeout(20_000, () => { sock.destroy(); reject(new AppError("internal", "Malware scanner timed out")); });
      sock.on("error", reject);
      sock.on("data", (d) => (out += d.toString()));
      sock.on("end", () => resolve(/FOUND/.test(out) ? { clean: false, detail: out.trim() } : { clean: /OK/.test(out), detail: out.trim() }));
      sock.write("zINSTREAM\0");
      for (let i = 0; i < buf.length; i += 65536) {
        const chunk = buf.subarray(i, i + 65536);
        const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length);
        sock.write(len); sock.write(chunk);
      }
      sock.end(Buffer.alloc(4));
    });
  }
}

let scanner: MalwareScanner | undefined;
export function getScanner(): MalwareScanner {
  if (scanner) return scanner;
  const h = process.env.CLAMAV_HOST;
  if (!h) return (scanner = new NoScanner());
  const [host, port] = h.split(":");
  return (scanner = new ClamdScanner(host!, Number(port ?? 3310)));
}

export async function assertClean(buf: Buffer) {
  const r = await getScanner().scan(buf);
  if (!r.clean) { log.security("malware_detected", { detail: r.detail }); throw new AppError("unsupported_media", "This file was rejected by the security scanner."); }
}
