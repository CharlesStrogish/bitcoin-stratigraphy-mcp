import { Router, type IRouter } from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GetStratigraphyResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const dataPath = fileURLToPath(
  new URL("../data/stratigraphy.json", import.meta.url),
);

router.get("/stratigraphy", async (_req, res): Promise<void> => {
  const raw = await readFile(dataPath, "utf8");
  const data = GetStratigraphyResponse.parse(JSON.parse(raw));
  res.json(data);
});

export default router;