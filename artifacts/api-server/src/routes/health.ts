import { Router, type IRouter } from "express";
import {
  DatasetHealthCheckResponse,
  HealthCheckResponse,
} from "@workspace/api-zod";
import { readDataset } from "./stratigraphy";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/v1/health", async (_req, res) => {
  const dataset = await readDataset();
  const data = DatasetHealthCheckResponse.parse({
    status: "ok",
    datasetLength: dataset.length,
    protocol: "L402",
  });
  res.status(200).json(data);
});

export default router;
