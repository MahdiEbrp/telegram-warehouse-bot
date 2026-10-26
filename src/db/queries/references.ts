import { eq } from "drizzle-orm";
import type { Transaction } from "@/db/client";
import { orderReferences } from "@/db/schema";
import { generateOrderReference } from "@/lib/reference";
import { RetryableError } from "@/lib/errors";

export async function allocateOrderReference(
  tx: Transaction,
  orderId: string,
  generate = generateOrderReference,
): Promise<string> {
  const [existing] = await tx
    .select()
    .from(orderReferences)
    .where(eq(orderReferences.orderId, orderId));
  if (existing) return existing.code;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generate();
    const [inserted] = await tx
      .insert(orderReferences)
      .values({ orderId, code })
      .onConflictDoNothing({ target: orderReferences.code })
      .returning({ code: orderReferences.code });
    if (inserted) return inserted.code;
  }
  throw new RetryableError("REFERENCE_ALLOCATION_FAILED");
}
