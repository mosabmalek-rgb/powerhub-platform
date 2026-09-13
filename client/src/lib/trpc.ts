import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../../server/routers";

const trpcBase = createTRPCReact<AppRouter>();

type ListComplaintsQuery = typeof trpcBase.admin.listComplaints.useQuery;
type OptionalInputListComplaintsQuery = ListComplaintsQuery & {
  (input?: Parameters<ListComplaintsQuery>[0], options?: Parameters<ListComplaintsQuery>[1]): ReturnType<ListComplaintsQuery>;
};

type ClientAdminRouter = Omit<typeof trpcBase.admin, "listComplaints"> & {
  listComplaints: Omit<typeof trpcBase.admin.listComplaints, "useQuery"> & {
    useQuery: OptionalInputListComplaintsQuery;
  };
};

type ClientTRPC = Omit<typeof trpcBase, "admin"> & {
  admin: ClientAdminRouter;
};

export const trpc = trpcBase as ClientTRPC;
