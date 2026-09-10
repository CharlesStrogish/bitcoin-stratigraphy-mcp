import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stratigraphyRouter from "./stratigraphy";

const router: IRouter = Router();

router.use(healthRouter);
router.use(stratigraphyRouter);

export default router;
