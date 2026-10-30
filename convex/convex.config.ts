import crons from "@convex-dev/crons/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
// Runtime-registered crons, used for recurring schedules.
app.use(crons);

export default app;
