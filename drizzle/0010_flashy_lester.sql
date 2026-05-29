CREATE TABLE "loan_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"borrower_name" varchar(255) NOT NULL,
	"amount" text NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"description" text,
	"status" varchar(20) DEFAULT 'outstanding' NOT NULL,
	"repaid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loan_entries" ADD CONSTRAINT "loan_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_entries_user_id_idx" ON "loan_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "loan_entries_created_at_idx" ON "loan_entries" USING btree ("created_at");