import "dotenv/config";
import { startBot } from "./discord/bot";

startBot().catch((error) => {
  console.error(error);
  process.exit(1);
});
