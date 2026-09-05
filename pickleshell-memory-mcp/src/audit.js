import { appendFileSync } from "node:fs";

export class Auditor {
  constructor(path, append = appendFileSync) { this.path = path; this.append = append; }
  record(event) {
    this.append(this.path, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\n", { encoding: "utf8", mode: 0o600 });
  }
}
