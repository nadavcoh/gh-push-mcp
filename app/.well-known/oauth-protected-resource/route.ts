import { protectedResourceHandler, metadataCorsOptionsRequestHandler } from "mcp-handler";

const handler = protectedResourceHandler({ authServerUrls: [process.env.BASE_URL!] });
export { handler as GET, metadataCorsOptionsRequestHandler as OPTIONS };
