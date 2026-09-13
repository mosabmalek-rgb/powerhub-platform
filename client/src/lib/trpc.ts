import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../../server/routers";

type ClientAppRouter = Omit<AppRouter, "admin"> & {
  admin: Omit<AppRouter["admin"], "listComplaints"> & {
    listComplaints: any;
  };
};

const trpcBase = createTRPCReact<ClientAppRouter>();

type ClientTRPC = Omit<typeof trpcBase, "admin"> & {
  admin: Omit<typeof trpcBase.admin, "listComplaints"> & {
    listComplaints: any;
  };
};

export const trpc = trpcBase as ClientTRPC;
