-- Disposable PostgreSQL 17 fixture for the exact, complete PR359 historical migration.
CREATE TABLE public.payments (
 id bigint PRIMARY KEY, tenant_id bigint NOT NULL,site_id bigint NOT NULL,subscriber_id bigint NOT NULL,
 invoice_id bigint,payment_no text NOT NULL,collected_by_user_id bigint,amount numeric(14,2) NOT NULL,
 status text NOT NULL,payment_purpose text NOT NULL,invoice_applied_amount numeric(14,2) NOT NULL,
 subscriber_credit_amount numeric(14,2) NOT NULL
);
CREATE TABLE public.subscriber_balance_ledger (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL,
 subscriber_id bigint NOT NULL,balance_type text NOT NULL,entry_type text NOT NULL,direction text NOT NULL,
 amount numeric(14,2) NOT NULL,payment_id bigint,idempotency_key text NOT NULL UNIQUE,
 created_by_user_id bigint,metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE public.audit_logs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id bigint,site_id bigint,user_id bigint,
 entity_type text NOT NULL,entity_id text NOT NULL,action text NOT NULL,
 before_data jsonb,after_data jsonb,metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO public.payments
(id,tenant_id,site_id,subscriber_id,invoice_id,payment_no,collected_by_user_id,amount,status,payment_purpose,invoice_applied_amount,subscriber_credit_amount)
VALUES
 (1,11,101,1001,5001,'PAY-1',201,120,'completed','invoice_collection',120,0),
 (2,11,101,1001,NULL,'PAY-2',201,55,'completed','invoice_collection',55,0),
 (3,11,101,1001,NULL,'PAY-3',201,45,'pending','invoice_collection',0,0),
 (4,11,101,1001,NULL,'PAY-4',201,31,'completed','subscriber_credit',31,0),
 (5,11,101,1001,NULL,'PAY-5',201,18,'completed','subscriber_credit',0,18),
 (6,11,101,1001,NULL,'PAY-6',201,24,'completed','invoice_collection',24,0),
 (7,11,101,1001,NULL,'PAY-7',201,12,'cancelled','invoice_collection',0,0),
 (8,11,101,1001,5008,'PAY-8',201,10,'completed','invoice_collection_with_credit',8,2),
 (9,22,202,2002,NULL,'PAY-9',301,64,'completed','invoice_collection',64,0);
INSERT INTO public.subscriber_balance_ledger
(tenant_id,site_id,subscriber_id,balance_type,entry_type,direction,amount,payment_id,idempotency_key,created_by_user_id,metadata)
VALUES (11,101,1001,'available_credit','receipt','credit',24,6,'subscriber-credit:payment:6',201,'{"source":"preexisting"}');
