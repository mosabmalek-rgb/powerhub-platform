import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../../server/routers";

type ClientAppRouter = Omit<AppRouter, "admin"> & {
  admin: Omit<AppRouter["admin"], "listComplaints"> & {
    listComplaints: any;
  };
};

export const trpc = createTRPCReact<ClientAppRouter>();
