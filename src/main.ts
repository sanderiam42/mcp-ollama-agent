import { ChatManager } from "./lib/ChatManager";
import { ollamaConfig } from "./config";

async function main() {
  const args = process.argv.slice(2);
  const flags = {
    sysprompt: args.includes("--sysprompt"),
    showpayloads: args.includes("--showpayloads"),
  };

  const chatManager = new ChatManager(ollamaConfig, flags);
  try {
    await chatManager.initialize();
    await chatManager.start();
  } catch (error) {
    console.error("Failed to start chat:", error);
  }
}

main().catch(console.error);
