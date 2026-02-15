## 8. Booking Service & Orchestration

> **Learning Objectives**
> - Understand how the booking service orchestrates inventory checks, payment processing, and confirmation into a single transactional flow
> - Recognize the role of inventory holds and their time-to-live (TTL) in preventing overselling
> - Learn how the outbox pattern is used to publish domain events reliably after a booking is created
> - Read a booking status state machine and trace every possible lifecycle transition
> - Identify where compensating actions (hold release) fit into error handling

**Why:** The booking service orchestrates the entire booking flow: checking inventory, creating holds, processing payments, and confirming reservations. This section shows the imperative flow; Section 13 (Saga Pattern) shows how to make this more resilient with compensating transactions. Fraud checks (Section 22) are performed before payment processing.

### 8.1 Booking Creation Flow

```typescript
// ============================================
// Booking Service - Core Orchestration
// ============================================

export class BookingService {

  async createBooking(dto: CreateBookingDto): Promise<Booking> {

    // 1. Check inventory availability
    const available = await this.inventoryService.checkAvailability({
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      date: dto.date
    });

    if (!available) {
      throw new InsufficientInventoryError();
    }

    // 2. Reserve inventory (creates a hold)
    const hold = await this.inventoryService.createHold({
      ...dto,
      ttlSeconds: 600  // 10 minutes
    });

    try {
      // 3. Process payment
      const payment = await this.paymentService.processPayment({
        amount: dto.totalAmount,
        currency: dto.currency,
        paymentMethod: dto.paymentMethod
      });

      // 4. Create booking record
      const booking = await this.createBookingRecord(dto, payment.id);

      // 5. Confirm hold
      await this.inventoryService.confirmHold(hold.id, booking.id);

      // 6. Write event to outbox (not directly to Kafka)
      await this.writeOutboxEvent('booking', booking.id, 'booking.created', {
        bookingId: booking.id,
        referenceCode: booking.referenceCode,
        userId: dto.userId,
        bookingType: dto.bookingType,
        totalAmount: dto.totalAmount,
        currency: dto.currency
      });

      return booking;

    } catch (error) {
      // Rollback: Release hold
      await this.inventoryService.releaseHold(hold.id, error.message, 'booking-service');
      throw error;
    }
  }

  // See Section 15 (Saga Pattern) for a more resilient orchestration approach
}
```

### 8.2 Booking Status State Machine

```
  +--------+     confirm     +-----------+     complete     +-----------+
  |pending |--------------->| confirmed |---------------->| completed |
  +---+----+                +-----+-----+                 +-----------+
      |                           |
      |  payment_failed           |  cancel
      |                           |
  +---v-----+              +------v-----+     refund     +----------+
  | failed  |              | cancelled  |--------------->| refunded |
  +---------+              +------------+                +----------+
```

### Key Takeaways

- The booking service follows a strict sequential flow: check availability, create hold, process payment, create record, confirm hold, publish event. Each step depends on the previous one succeeding.
- Inventory holds with a TTL (10 minutes) act as a pessimistic lock that prevents double-selling while giving the system time to complete payment processing.
- The outbox pattern (step 6) ensures that the `booking.created` event is persisted in the same database transaction as the booking itself, guaranteeing at-least-once delivery without distributed transaction overhead.
- Error handling releases the inventory hold immediately so that the resource becomes available to other customers rather than remaining locked until TTL expiry.
- The state machine defines exactly five terminal and intermediate states; every transition is explicit, making it straightforward to audit booking lifecycle in production.

### Review Questions

1. **Conceptual:** Why does the booking service create an inventory hold *before* processing payment, rather than after? What would happen if the order were reversed?
2. **Code-Reading:** In the `createBooking` method, the `catch` block calls `releaseHold` but does *not* reverse the payment. Why is this safe given that the payment call is the first operation inside the `try` block? Under what circumstances could a payment succeed but the booking still fail?
3. **Conceptual:** The state machine shows that a booking can move from `confirmed` to `cancelled` to `refunded`, but there is no direct arrow from `confirmed` to `refunded`. Why might the system enforce this two-step transition instead of allowing a single jump?

### Hands-On Exercise

**Exercise: Extend the State Machine for Partial Cancellations**

Many real-world booking platforms allow partial cancellations (e.g., cancelling one night of a three-night hotel stay). Modify the state machine diagram to add a `partially_cancelled` state. Then write pseudocode for a `partialCancel` method on `BookingService` that: (a) validates the cancellation request against the booking line items, (b) creates a hold release for only the cancelled portion, (c) initiates a partial refund, and (d) transitions the booking to the new state. Consider what happens if the partial refund fails -- should the booking remain in `confirmed` or move to `partially_cancelled`?

---

## 9. Payment & Accounting System

> **Learning Objectives**
> - Understand the dual nature of financial tracking: external payment flow (Stripe) and internal double-entry accounting
> - Read a chart of accounts and identify the purpose of each account category (assets, liabilities, revenue, expenses, equity)
> - Trace how a customer payment moves through clearing accounts into revenue via journal entries
> - Explain why immutability of posted accounting entries is enforced at the database level with triggers
> - Recognize common accounting mistakes such as mixing distinct economic events in a single journal entry and SQL injection in date filtering

**Why:** Financial operations require two levels of tracking: (1) the payment flow with external providers (Stripe), and (2) internal double-entry accounting for audit compliance. Every dollar must be traceable from customer payment through revenue recognition to supplier payout.

### 9.1 Chart of Accounts

```sql
-- Complete chart of accounts for the booking platform
CREATE TABLE chart_of_accounts (
    account_code VARCHAR(50) PRIMARY KEY,
    account_name VARCHAR(255) NOT NULL,
    account_type ENUM('asset', 'liability', 'revenue', 'expense', 'equity') NOT NULL,
    parent_account VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    is_system_account BOOLEAN DEFAULT FALSE,
    currency CHAR(3) DEFAULT 'USD',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (parent_account) REFERENCES chart_of_accounts(account_code),
    INDEX idx_type (account_type),
    INDEX idx_parent (parent_account)
);

INSERT INTO chart_of_accounts (account_code, account_name, account_type, is_system_account) VALUES
-- Assets (1000-1999)
('1000', 'Cash and Cash Equivalents', 'asset', TRUE),
('1100', 'Accounts Receivable', 'asset', TRUE),
('1110', 'Customer Receivables', 'asset', TRUE),
('1200', 'Payment Gateway Clearing', 'asset', TRUE),
('1210', 'Stripe Clearing', 'asset', TRUE),
('1220', 'PayPal Clearing', 'asset', TRUE),
('1300', 'Prepaid Expenses', 'asset', TRUE),
-- Liabilities (2000-2999)
('2000', 'Accounts Payable', 'liability', TRUE),
('2100', 'Customer Deposits', 'liability', TRUE),
('2110', 'Unearned Revenue', 'liability', TRUE),
('2200', 'Supplier Payables', 'liability', TRUE),
('2210', 'Hotel Suppliers Payable', 'liability', TRUE),
('2220', 'Flight Suppliers Payable', 'liability', TRUE),
('2230', 'Car Rental Suppliers Payable', 'liability', TRUE),
('2300', 'Refunds Payable', 'liability', TRUE),
-- Revenue (4000-4999)
('4000', 'Operating Revenue', 'revenue', TRUE),
('4100', 'Booking Revenue', 'revenue', TRUE),
('4110', 'Hotel Booking Revenue', 'revenue', TRUE),
('4120', 'Flight Booking Revenue', 'revenue', TRUE),
('4130', 'Car Rental Revenue', 'revenue', TRUE),
('4200', 'Service Fees', 'revenue', TRUE),
('4210', 'Booking Fees', 'revenue', TRUE),
('4220', 'Cancellation Fees', 'revenue', TRUE),
-- Expenses (5000-5999)
('5000', 'Operating Expenses', 'expense', TRUE),
('5100', 'Cost of Sales', 'expense', TRUE),
('5110', 'Hotel Costs', 'expense', TRUE),
('5120', 'Flight Costs', 'expense', TRUE),
('5130', 'Car Rental Costs', 'expense', TRUE),
('5200', 'Payment Processing Fees', 'expense', TRUE),
('5210', 'Credit Card Fees', 'expense', TRUE),
('5220', 'PayPal Fees', 'expense', TRUE),
('5300', 'Refunds and Chargebacks', 'expense', TRUE),
-- Equity (3000-3999)
('3000', 'Shareholders Equity', 'equity', TRUE),
('3100', 'Retained Earnings', 'equity', TRUE);
```

### 9.2 Accounting Entries Tables

```sql
CREATE TABLE accounting_entries (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    entry_number VARCHAR(50) NOT NULL UNIQUE,
    entry_date DATE NOT NULL,
    entry_type ENUM('journal', 'payment', 'refund', 'adjustment') NOT NULL,
    booking_id BIGINT,
    transaction_id BIGINT,
    user_id BIGINT,
    description TEXT,
    is_posted BOOLEAN DEFAULT FALSE,
    posted_at TIMESTAMP NULL,
    posted_by BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by BIGINT,

    CONSTRAINT chk_posted_immutable CHECK (
        is_posted = FALSE OR
        (is_posted = TRUE AND posted_at IS NOT NULL)
    ),

    INDEX idx_booking (booking_id),
    INDEX idx_date (entry_date),
    INDEX idx_posted (is_posted, posted_at)
);

CREATE TABLE accounting_entry_lines (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    entry_id BIGINT NOT NULL,
    line_number SMALLINT NOT NULL,
    account_code VARCHAR(50) NOT NULL,
    debit_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    credit_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    exchange_rate DECIMAL(12,6) DEFAULT 1.000000,
    description TEXT,
    reference_type VARCHAR(50),
    reference_id BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (entry_id) REFERENCES accounting_entries(id) ON DELETE RESTRICT,
    FOREIGN KEY (account_code) REFERENCES chart_of_accounts(account_code),

    CONSTRAINT chk_debit_or_credit CHECK (
        (debit_amount > 0 AND credit_amount = 0) OR
        (debit_amount = 0 AND credit_amount > 0)
    ),

    INDEX idx_entry_line (entry_id, line_number),
    INDEX idx_account (account_code)
);
```

### 9.3 Balanced Entry Validation Trigger

```sql
DELIMITER //

CREATE TRIGGER validate_balanced_entry_before_post
BEFORE UPDATE ON accounting_entries
FOR EACH ROW
BEGIN
    DECLARE v_total_debit DECIMAL(12,2);
    DECLARE v_total_credit DECIMAL(12,2);

    -- Only validate when posting
    IF NEW.is_posted = TRUE AND OLD.is_posted = FALSE THEN

        SELECT SUM(debit_amount), SUM(credit_amount)
        INTO v_total_debit, v_total_credit
        FROM accounting_entry_lines
        WHERE entry_id = NEW.id;

        -- Fundamental accounting equation: Debits = Credits
        IF ABS(v_total_debit - v_total_credit) > 0.01 THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = CONCAT(
                'Accounting entry is not balanced. ',
                'Debits: ', v_total_debit, ', ',
                'Credits: ', v_total_credit
            );
        END IF;

        IF (SELECT COUNT(*) FROM accounting_entry_lines WHERE entry_id = NEW.id) < 2 THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Accounting entry must have at least 2 lines (debit and credit)';
        END IF;

        SET NEW.posted_at = NOW();
    END IF;
END//

DELIMITER ;
```

> **Common Mistake: DECLARE After IF in MySQL Triggers**
> In MySQL stored programs, all `DECLARE` statements must appear at the very top of the `BEGIN` block, before any other statements including `IF`. Placing `DECLARE` after an `IF` causes a syntax error. The v2 trigger above correctly places both `DECLARE` statements before the `IF NEW.is_posted` check.

### 9.3.1 Immutability Triggers

Once an accounting entry is posted, it must **never** be modified or deleted — corrections are made via reversing journal entries. These triggers enforce immutability at the database level:

```sql
DELIMITER //

-- Prevent modification of posted entries
CREATE TRIGGER prevent_posted_entry_modification
BEFORE UPDATE ON accounting_entries
FOR EACH ROW
BEGIN
    IF OLD.is_posted = TRUE AND NEW.id = OLD.id THEN
        -- Only allow the is_posted transition (FALSE -> TRUE), handled by balanced entry trigger
        IF OLD.is_posted = TRUE AND NEW.is_posted = TRUE THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Cannot modify a posted accounting entry. Create a reversing entry instead.';
        END IF;
    END IF;
END//

-- Prevent deletion of posted entries
CREATE TRIGGER prevent_posted_entry_deletion
BEFORE DELETE ON accounting_entries
FOR EACH ROW
BEGIN
    IF OLD.is_posted = TRUE THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Cannot delete a posted accounting entry. Create a reversing entry instead.';
    END IF;
END//

DELIMITER ;
```

### 9.3.2 Entry Number Generator

Entry numbers follow a deterministic format: `{type prefix}-{YYYYMMDD}-{sequence}`. The sequence resets daily and is generated atomically to avoid duplicates under concurrency:

```sql
-- Supporting sequence table
CREATE TABLE entry_number_sequences (
    entry_type VARCHAR(20) NOT NULL,
    entry_date DATE NOT NULL,
    next_sequence INT NOT NULL DEFAULT 1,
    PRIMARY KEY (entry_type, entry_date)
);
```

```typescript
  private async generateEntryNumber(entryType: string): Promise<string> {
    const prefix = entryType === 'payment' ? 'PAY' : 'JNL';
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // Atomic increment using INSERT ... ON DUPLICATE KEY UPDATE
    await db.execute(`
      INSERT INTO entry_number_sequences (entry_type, entry_date, next_sequence)
      VALUES (?, CURDATE(), 2)
      ON DUPLICATE KEY UPDATE next_sequence = next_sequence + 1
    `, [entryType]);

    // Retrieve the sequence that was assigned
    const [rows] = await db.execute(`
      SELECT next_sequence - 1 AS seq
      FROM entry_number_sequences
      WHERE entry_type = ? AND entry_date = CURDATE()
    `, [entryType]);

    const seq = String(rows[0].seq).padStart(6, '0');
    return `${prefix}-${today}-${seq}`;
  }
```

### 9.4 Accounting Service

```typescript
// ============================================
// Double-Entry Accounting Service
// ============================================

export class AccountingService {

  async recordCustomerPayment(params: {
    bookingId: bigint;
    transactionId: bigint;
    amount: number;
    currency: string;
    paymentProvider: string;
  }): Promise<void> {

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const entryNumber = await this.generateEntryNumber('payment');

      const [paymentResult] = await connection.execute(`
        INSERT INTO accounting_entries (
          entry_number, entry_date, entry_type,
          booking_id, transaction_id, description, created_by
        ) VALUES (?, CURDATE(), 'payment', ?, ?, ?, ?)
      `, [entryNumber, params.bookingId, params.transactionId,
          `Customer payment received for booking ${params.bookingId}`, null]);

      const entryId = paymentResult.insertId;

      // Debit: Payment Gateway Clearing (Asset increases)
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, currency,
          description, reference_type, reference_id
        ) VALUES (?, 1, ?, ?, 0, ?, ?, 'transaction', ?)
      `, [entryId, this.getPaymentGatewayAccount(params.paymentProvider),
          params.amount, params.currency,
          `Payment received via ${params.paymentProvider}`, params.transactionId]);

      // Credit: Customer Deposits (Liability increases)
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, currency,
          description, reference_type, reference_id
        ) VALUES (?, 2, '2100', 0, ?, ?, ?, 'booking', ?)
      `, [entryId, params.amount, params.currency,
          'Customer deposit for booking', params.bookingId]);

      // Post entry (triggers balanced validation)
      await connection.execute(
        'UPDATE accounting_entries SET is_posted = TRUE WHERE id = ?',
        [entryId]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Revenue recognition -- split into TWO separate journal entries
   * for proper accounting treatment
   */
  async recognizeBookingRevenue(params: {
    bookingId: bigint;
    bookingType: string;
    amount: number;
    supplierCost: number;
  }): Promise<void> {

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // ==========================================
      // ENTRY 1: Revenue Recognition
      // Transfer from liability to revenue
      // ==========================================
      const revenueEntryNumber = await this.generateEntryNumber('journal');

      const [revenueResult] = await connection.execute(`
        INSERT INTO accounting_entries (
          entry_number, entry_date, entry_type,
          booking_id, description
        ) VALUES (?, CURDATE(), 'journal', ?, ?)
      `, [revenueEntryNumber, params.bookingId,
          `Revenue recognition for ${params.bookingType} booking`]);

      const revenueEntryId = revenueResult.insertId;

      // Debit: Customer Deposits (Liability decreases)
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, description
        ) VALUES (?, 1, '2100', ?, 0, 'Transfer from customer deposit')
      `, [revenueEntryId, params.amount]);

      // Credit: Booking Revenue (Revenue increases)
      const revenueAccount = this.getRevenueAccount(params.bookingType);
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, description
        ) VALUES (?, 2, ?, 0, ?, 'Booking revenue recognized')
      `, [revenueEntryId, revenueAccount, params.amount]);

      await connection.execute(
        'UPDATE accounting_entries SET is_posted = TRUE WHERE id = ?',
        [revenueEntryId]
      );

      // ==========================================
      // ENTRY 2: Cost Accrual
      // Record supplier cost as a separate economic event
      // ==========================================
      const costEntryNumber = await this.generateEntryNumber('journal');

      const [costResult] = await connection.execute(`
        INSERT INTO accounting_entries (
          entry_number, entry_date, entry_type,
          booking_id, description
        ) VALUES (?, CURDATE(), 'journal', ?, ?)
      `, [costEntryNumber, params.bookingId,
          `Cost accrual for ${params.bookingType} booking`]);

      const costEntryId = costResult.insertId;

      // Debit: Cost of Sales (Expense increases)
      const costAccount = this.getCostAccount(params.bookingType);
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, description
        ) VALUES (?, 1, ?, ?, 0, 'Supplier cost for booking')
      `, [costEntryId, costAccount, params.supplierCost]);

      // Credit: Supplier Payables (Liability increases)
      const payableAccount = this.getSupplierPayableAccount(params.bookingType);
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, description
        ) VALUES (?, 2, ?, 0, ?, 'Amount owed to supplier')
      `, [costEntryId, payableAccount, params.supplierCost]);

      await connection.execute(
        'UPDATE accounting_entries SET is_posted = TRUE WHERE id = ?',
        [costEntryId]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Get account balance with parameterized date filtering
   */
  async getAccountBalance(accountCode: string, asOfDate?: Date): Promise<number> {
    const queryParams: any[] = [accountCode];
    let dateFilter = '';

    if (asOfDate) {
      dateFilter = 'AND ae.entry_date <= ?';
      queryParams.push(asOfDate);
    }

    const [rows] = await db.execute(`
      SELECT
        SUM(ael.debit_amount) as total_debits,
        SUM(ael.credit_amount) as total_credits
      FROM accounting_entry_lines ael
      INNER JOIN accounting_entries ae ON ael.entry_id = ae.id
      WHERE ael.account_code = ?
      AND ae.is_posted = TRUE
      ${dateFilter}
    `, queryParams);

    const totalDebits = rows[0]?.total_debits || 0;
    const totalCredits = rows[0]?.total_credits || 0;

    const [accountInfo] = await db.execute(
      'SELECT account_type FROM chart_of_accounts WHERE account_code = ?',
      [accountCode]
    );

    const accountType = accountInfo[0]?.account_type;

    // Assets & Expenses: Debit balance (debits - credits)
    // Liabilities, Revenue & Equity: Credit balance (credits - debits)
    if (accountType === 'asset' || accountType === 'expense') {
      return totalDebits - totalCredits;
    }
    return totalCredits - totalDebits;
  }

  private getPaymentGatewayAccount(provider: string): string {
    const mapping: Record<string, string> = { stripe: '1210', paypal: '1220' };
    return mapping[provider.toLowerCase()] || '1200';
  }

  private getRevenueAccount(bookingType: string): string {
    const mapping: Record<string, string> = { hotel: '4110', flight: '4120', car: '4130' };
    return mapping[bookingType.toLowerCase()] || '4100';
  }

  private getCostAccount(bookingType: string): string {
    const mapping: Record<string, string> = { hotel: '5110', flight: '5120', car: '5130' };
    return mapping[bookingType.toLowerCase()] || '5100';
  }

  private getSupplierPayableAccount(bookingType: string): string {
    const mapping: Record<string, string> = { hotel: '2210', flight: '2220', car: '2230' };
    return mapping[bookingType.toLowerCase()] || '2200';
  }
}
```

> **Common Mistake: Mixing Revenue and Cost in One Journal Entry**
> An earlier version combined revenue recognition and cost accrual into a single 4-line journal entry. While the entry was technically balanced (debits = credits), it violated the accounting principle of separating distinct economic events. Revenue recognition (customer deposit -> revenue) and cost accrual (expense -> supplier payable) are independent transactions that may occur at different times and should be auditable separately.

> **Common Mistake: SQL Injection in Date Filtering**
> An earlier version of `getAccountBalance` interpolated the date directly into the SQL string: `` `AND ae.entry_date <= '${format(asOfDate, ...)}'` ``. This creates a SQL injection vulnerability. Always use parameterized queries (`?` placeholders) for all dynamic values, even dates.

### 9.5 Payment Processing Flow

```typescript
// ============================================
// Payment Service
// ============================================

export class PaymentService {

  async processPayment(params: PaymentParams): Promise<PaymentResult> {

    // Step 1: Fraud check (Section 24)
    const fraudCheck = await this.fraudService.checkTransaction({
      userId: params.userId,
      amount: params.amount,
      ipAddress: params.ipAddress,
      deviceFingerprint: params.deviceFingerprint
    });

    if (fraudCheck.status === 'blocked') {
      throw new FraudBlockedError('Transaction blocked by fraud detection');
    }

    // Step 2: Authorization (hold funds)
    const authorization = await this.authorizePayment(params);

    if (!authorization.success) {
      throw new PaymentDeclinedError(authorization.reason);
    }

    // Step 3: Record in payment ledger
    await this.ledgerService.recordAuthorization(
      params.bookingId, authorization.transactionId,
      params.amount, params.currency, params.provider,
      authorization.providerTxnId
    );

    // Step 4: Capture (actually charge)
    const capture = await this.capturePayment(authorization.providerTxnId, params.amount);

    if (!capture.success) {
      await this.voidAuthorization(authorization.providerTxnId);
      throw new PaymentCaptureError(capture.reason);
    }

    // Step 5: Record capture in ledger
    await this.ledgerService.recordCapture(
      params.bookingId, authorization.transactionId,
      params.amount, params.currency
    );

    // Step 6: Update accounting
    await this.accountingService.recordCustomerPayment({
      bookingId: params.bookingId,
      transactionId: authorization.transactionId,
      amount: params.amount,
      currency: params.currency,
      paymentProvider: params.provider
    });

    return {
      success: true,
      transactionId: authorization.transactionId,
      providerTxnId: authorization.providerTxnId
    };
  }

  private async authorizePayment(params: PaymentParams): Promise<any> {
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(params.amount * 100),  // cents
        currency: params.currency.toLowerCase(),
        payment_method: params.paymentMethodId,
        capture_method: 'manual',  // Authorization only
        metadata: {
          booking_id: params.bookingId.toString(),
          user_id: params.userId.toString()
        }
      });

      return {
        success: true,
        transactionId: await this.createTransactionRecord(params, paymentIntent.id),
        providerTxnId: paymentIntent.id
      };
    } catch (error) {
      return { success: false, reason: error.message };
    }
  }

  private async capturePayment(providerTxnId: string, amount: number): Promise<any> {
    try {
      await stripe.paymentIntents.capture(providerTxnId, {
        amount_to_capture: Math.round(amount * 100)
      });
      return { success: true };
    } catch (error) {
      return { success: false, reason: error.message };
    }
  }
}
```

### Key Takeaways

- The payment and accounting system operates on two distinct layers: the payment layer handles real-time interactions with external providers (Stripe), while the accounting layer records every financial movement as immutable double-entry journal entries for audit compliance.
- The chart of accounts uses a standardized numbering scheme (1000s for assets, 2000s for liabilities, 3000s for equity, 4000s for revenue, 5000s for expenses) with sub-accounts that map directly to booking types (hotel, flight, car rental).
- Database triggers enforce the fundamental accounting equation (debits = credits) at the moment an entry is posted, preventing unbalanced entries from ever reaching persistent storage.
- Immutability of posted entries is enforced at the database level through triggers that block UPDATE and DELETE operations; corrections are always made through reversing journal entries, preserving a complete audit trail.
- Revenue recognition and cost accrual are recorded as separate journal entries because they represent distinct economic events that may occur at different times and must be independently auditable.

### Review Questions

1. **Code-Reading:** In the `recordCustomerPayment` method, the debit goes to Payment Gateway Clearing (an asset account) and the credit goes to Customer Deposits (a liability account). Walk through why both sides of this entry increase: how does debiting an asset increase it, and how does crediting a liability increase it?
2. **Conceptual:** The `generateEntryNumber` method uses `INSERT ... ON DUPLICATE KEY UPDATE` to atomically increment a sequence counter. Why is this approach preferred over a simple `SELECT` followed by `UPDATE`? What concurrency problem would the two-step approach introduce?
3. **Code-Reading:** Examine the `getAccountBalance` method. It returns `totalDebits - totalCredits` for assets and expenses, but `totalCredits - totalDebits` for liabilities, revenue, and equity. Explain why this inversion is necessary by referencing the accounting equation `Assets = Liabilities + Equity`.

### Hands-On Exercise

**Exercise: Implement a Refund Journal Entry**

Write a `recordRefund` method on the `AccountingService` that handles a full refund for a booking. The method should create two journal entries: (1) a reversal of the original customer payment (debit Customer Deposits / credit Payment Gateway Clearing), and (2) a reversal of the revenue recognition (debit Booking Revenue / credit Customer Deposits). Use the existing `generateEntryNumber` method with `entry_type = 'refund'` for the first entry and `'journal'` for the second. Make sure both entries are posted within a single database transaction and that the balanced-entry validation trigger will accept them. Test your logic by tracing the account balances before and after the refund to confirm they net to zero for the refunded booking.

---

## 10. Notification Service

> **Learning Objectives**
> - Understand how the notification service decouples delivery from booking logic by consuming events from Kafka
> - Identify the three notification channels (email, SMS, push) and how user preferences control which channels are used
> - Recognize the role of templates in rendering channel-specific content from a single event payload
> - Learn how `Promise.allSettled` enables parallel delivery across channels without one failure blocking the others
> - Understand how failed deliveries are routed to a retry queue (Dead Letter Queue) for reliable eventual delivery

**Why:** Users need immediate confirmation when they book, reminders before check-in, and alerts on changes. The notification service consumes events from Kafka (published via the Outbox Pattern) and delivers them through multiple channels.

### 10.1 Multi-Channel Notification Service

```typescript
// ============================================
// Notification Service - Kafka Consumer
// ============================================

export class NotificationService {
  private readonly providers = {
    email: new SESEmailProvider(),
    sms: new TwilioSMSProvider(),
    push: new FCMPushProvider()
  };

  async startConsumer(): Promise<void> {
    await kafka.subscribe({ topic: 'notification-events', fromBeginning: false });

    await kafka.run({
      eachMessage: async ({ message }) => {
        const event = JSON.parse(message.value.toString());
        await this.processNotification(event);
      }
    });
  }

  private async processNotification(event: NotificationEvent): Promise<void> {
    const user = await this.userService.getById(event.userId);
    const preferences = await this.getPreferences(event.userId);
    const template = this.getTemplate(event.type);

    const rendered = template.render({
      userName: user.name,
      ...event.data
    });

    // Send through preferred channels
    const results = await Promise.allSettled([
      preferences.email && this.providers.email.send({
        to: user.email,
        subject: rendered.subject,
        html: rendered.htmlBody
      }),
      preferences.sms && this.providers.sms.send({
        to: user.phone,
        body: rendered.smsBody
      }),
      preferences.push && this.providers.push.send({
        token: user.pushToken,
        title: rendered.pushTitle,
        body: rendered.pushBody
      })
    ]);

    // Log delivery results
    for (const result of results) {
      if (result.status === 'rejected') {
        // Failed deliveries go to DLQ for retry (Section 21)
        await this.writeToRetryQueue(event, result.reason);
      }
    }
  }

  private getTemplate(type: string): NotificationTemplate {
    const templates: Record<string, NotificationTemplate> = {
      'booking.created': new BookingConfirmationTemplate(),
      'booking.cancelled': new BookingCancellationTemplate(),
      'booking.reminder': new CheckInReminderTemplate(),
      'payment.refunded': new RefundConfirmationTemplate()
    };
    return templates[type] || new GenericTemplate();
  }
}
```

### Key Takeaways

- The notification service is fully decoupled from the booking and payment services; it reacts to domain events consumed from Kafka rather than being called directly, which means booking latency is never affected by notification delivery times.
- User preferences gate which channels receive notifications, and `Promise.allSettled` ensures that a failure in one channel (e.g., an invalid push token) does not prevent delivery through the remaining channels.
- Templates map event types to channel-specific renderings (HTML for email, plain text for SMS, title/body for push), keeping presentation logic separated from delivery infrastructure.
- Failed deliveries are not silently dropped; they are written to a retry queue (Dead Letter Queue, covered in Section 21) so that transient failures (e.g., Twilio rate limits, SES throttling) are eventually resolved.
- The consumer subscribes with `fromBeginning: false`, meaning it only processes new events from the point of subscription onward, avoiding reprocessing the entire event history on service restart.

### Review Questions

1. **Conceptual:** The notification service subscribes to Kafka with `fromBeginning: false`. What would happen if you changed this to `fromBeginning: true` after the service had been running in production for six months? What safeguards would you need to add to avoid sending duplicate or outdated notifications?
2. **Code-Reading:** The `processNotification` method passes `preferences.email && this.providers.email.send(...)` into the `Promise.allSettled` array. What value does JavaScript evaluate this expression to when `preferences.email` is `false`? Does `Promise.allSettled` handle that value correctly, or could it cause a runtime error?
3. **Conceptual:** Why does the notification service use `Promise.allSettled` instead of `Promise.all`? Describe a concrete scenario where using `Promise.all` would cause a user to miss a notification they should have received.

### Hands-On Exercise

**Exercise: Add a Webhook Notification Channel**

Extend the `NotificationService` to support a fourth channel: webhooks. Many business customers integrate booking platforms with their own systems (e.g., a corporate travel dashboard) via webhook callbacks. Implement a `WebhookProvider` class that POSTs the rendered notification payload to a URL stored in the user's preferences. Your implementation should: (a) include a configurable timeout (default 5 seconds) to avoid blocking the consumer, (b) include an HMAC signature header so the receiver can verify authenticity, (c) treat any non-2xx response as a failure that routes to the retry queue, and (d) integrate into the existing `Promise.allSettled` array alongside email, SMS, and push. Write the provider class and show the modifications to `processNotification`.

---
