import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../../server/routers";

type ClientAppRouter = Omit<AppRouter, "admin"> & {
  admin: Omit<AppRouter["admin"], "listComplaints"> & {
    listComplaints: any;
  };
};

const trpcBase = createTRPCReact<ClientAppRouter>();
type ComplaintQueryProxy = typeof trpcBase.admin.listComplaints;
type ComplaintQueryOverride = Omit<ComplaintQueryProxy, "useQuery"> & {
  useQuery: (...args: any[]) => ReturnType<ComplaintQueryProxy["useQuery"]>;
};

type ClientTRPC = Omit<typeof trpcBase, "admin"> & {
  admin: Omit<typeof trpcBase.admin, "listComplaints"> & {
    listComplaints: ComplaintQueryOverride;
  };
};

export const trpc = trpcBase as ClientTRPC;
