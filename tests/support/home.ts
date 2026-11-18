import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A test that forgets GRENIER_HOME lands in this throwaway home, never in the real ~/.grenier.
const home = realpathSync(mkdtempSync(join(tmpdir(), "grenier-home-")));
process.env.HOME = home;
process.env.USERPROFILE = home;
