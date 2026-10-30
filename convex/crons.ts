import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Static jobs of this deployment. Recurring client schedules are registered at
// runtime with the crons component instead (see recurring.ts).
const crons = cronJobs();

crons.daily("prune request ids", { hourUTC: 3, minuteUTC: 0 }, internal.requests.prune, {});

export default crons;
