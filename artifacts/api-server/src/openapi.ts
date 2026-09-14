import { parse } from "yaml";
import openApiSource from "../../../lib/api-spec/openapi.yaml";

export const openApiDocument = parse(openApiSource) as Record<string, unknown>;