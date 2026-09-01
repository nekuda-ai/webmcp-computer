import { Bash } from "just-bash";

const out = document.getElementById("out")!;
const log = (s: string) => { out.textContent += "\n" + s; };

async function run() {
  out.textContent = "constructing Bash()…";
  const bash = new Bash();

  const cases: Array<[string, string]> = [
    ["echo + redirect", `echo "hello from browser" > /tmp/greet.txt && cat /tmp/greet.txt`],
    ["pipes + grep", `printf 'alpha\\nbeta\\ngamma\\n' | grep a | sort`],
    ["awk", `printf '1 one\\n2 two\\n' | awk '{print $2}'`],
    ["jq", `echo '{"a":{"b":42}}' | jq .a.b`],
    ["fs state shared", `ls /tmp && wc -c /tmp/greet.txt`],
    ["sed", `echo 'foo bar' | sed 's/bar/baz/'`],
  ];

  for (const [name, cmd] of cases) {
    try {
      const r = await bash.exec(cmd);
      log(`[${name}] exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
    } catch (e) {
      log(`[${name}] THREW: ${e}`);
    }
  }
  log("DONE");
}

run().catch((e) => log("FATAL: " + (e?.stack ?? e)));
