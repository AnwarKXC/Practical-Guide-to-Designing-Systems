# Chapter 13: Financial Ledger & Double-Entry Accounting

## The INSERT That Lies

Right now, your mental model of "handling money" probably looks like this:

```typescript
// What you have done before
await db.query(
  'INSERT INTO payments (amount, user_id, status) VALUES ($1, $2, $3)',
  [100.00, userId, 'completed']
);
```

One row. One table. The user paid $100. Done. Ship it.

This works for a hobby project. It will **destroy** a real business. Here is why:

**No audit trail.** Where did the $100 go? Into your company's bank account? Into a holding account waiting to be sent to the hotel? Split between your commission and the supplier? The single row does not say. If a regulator asks "show me the money trail for this transaction," you have nothing to show them.

**No balance verification.** How much money is in the system right now? You would have to SUM the `amount` column with various WHERE clauses and hope you did not miss a filter. What about refunds? Chargebacks? Partial payments? Every special case is a new query you might get wrong.

**Easy to corrupt.** Someone accidentally updates a payment row: `UPDATE payments SET amount = 50 WHERE id = 42`. Was it $100 or $50? You do not know. There is no history, no second record to cross-reference. One bad UPDATE and the truth is gone.

**No separation of concerns.** The $100 from the customer is NOT your revenue. Not yet. The customer paid you, but you owe most of that to the hotel. Your revenue is the commission. Until the guest actually checks in, that $100 is a *liability* -- money you might have to refund. A single `payments` table conflates all of these concepts.

> **What If You Skip This?** If you store financial data in a single table without double-entry accounting: (1) you will fail any serious audit, (2) you cannot produce accurate financial statements, (3) you will eventually lose track of money -- which in a regulated business means fines, lawsuits, or worse. Every real fintech, marketplace, and booking platform uses double-entry accounting internally. This is not optional.

---

## Why Every Booking System Needs Double-Entry Accounting

You might think double-entry accounting is something only banks and Fortune 500 companies worry about. You would be wrong. The moment your system touches real money -- especially *other people's money* -- you are subject to legal and regulatory obligations that a single `payments` table cannot satisfy. Let us be specific.

### Legal and Regulatory Requirements

**Financial reporting obligations.** In most jurisdictions, any company that processes payments on behalf of others (which is exactly what a booking platform does) must produce auditable financial records. In the US, this falls under GAAP (Generally Accepted Accounting Principles). In Europe, it is IFRS (International Financial Reporting Standards). Both require double-entry bookkeeping. A single `payments` table does not comply with either.

**Money transmission laws.** When a customer pays $340 for a hotel and you hold that money before forwarding it to the hotel, you are temporarily holding someone else's funds. Many jurisdictions classify this as money transmission, which requires specific licenses and recordkeeping practices. The records must show, for every dollar: where it came from, where it is now, and where it is going. Double-entry accounting does exactly this.

**Tax authority requirements.** Tax authorities (the IRS, HMRC, the Finanzamt) expect you to distinguish between revenue and deposits, between gross receipts and net income, between money you earned and money you are holding. If you recognize all incoming payments as revenue the moment they arrive, you will overstate your taxable income. When the tax authority audits you and discovers you owe refunds on half those "earnings," the corrections are painful and the penalties are real.

**PCI DSS compliance.** If you store or process card data, you must comply with the Payment Card Industry Data Security Standard. Part of compliance involves maintaining complete audit trails of all payment transactions. An immutable, double-entry ledger provides exactly this.

### The Audit Problem

Imagine this scenario: it is 18 months after launch. Your booking platform processes $2 million per month. An auditor arrives and asks three questions:

1. "Show me every dollar that flowed through your system last quarter, and where each dollar ended up."
2. "Prove that no financial record has been tampered with since it was created."
3. "Explain the $14,000 discrepancy between your payment processor's records and your internal records."

With a single `payments` table, you cannot answer any of these questions with confidence. With a double-entry ledger, immutability triggers, and reconciliation processes, you can answer all three in minutes.

> **Analogy:** A single payments table is like a cash register receipt -- it tells you that money came in, but not what happened to it after that. Double-entry accounting is like a complete set of bank statements, invoices, and transfer records. The receipt might be enough for a lemonade stand. It is not enough for a business that holds other people's money.

---

## What Is Double-Entry Accounting?

Double-entry accounting is a 700-year-old invention. Luca Pacioli described it in 1494. Every bank, every public company, and every serious financial system uses it. The core rule is simple:

**Every financial transaction must be recorded in at least two accounts, and the total debits must equal the total credits.**

That is it. That is the entire rule. But its implications are profound.

> **Analogy:** Imagine you have a notebook with two columns: "Where did the money come from?" and "Where did the money go?" Every time money moves, you write one line in each column. If you receive $100 from a customer, the left column says "$100 from customer" and the right column says "$100 into our clearing account." The two columns always add up to the same total. If they do not, something is wrong and you know it immediately. That is double-entry accounting.

> **Key Term:** **Double-Entry Accounting** -- A bookkeeping system where every transaction creates at least two entries: a debit in one account and a credit in another. The sum of all debits must always equal the sum of all credits across the entire system. If they do not balance, you have an error.

### The Accounting Equation

Before we touch debits and credits, you need to understand the equation that underpins all of accounting:

```
Assets = Liabilities + Equity
```

This is not a formula you calculate occasionally. It is an **invariant** -- a condition that must be true at every single moment. If it is ever violated, your books are broken. Think of it like a database constraint that applies to the entire financial system.

For our booking platform:
- **Assets**: Cash in bank accounts, money sitting at Stripe, amounts customers owe us
- **Liabilities**: Deposits we might have to refund, amounts we owe hotels and airlines
- **Equity**: The owner's stake, plus accumulated profits (retained earnings)

Revenue and expenses feed into equity through retained earnings. When you earn $50 commission, equity increases by $50. When you pay $10 in credit card processing fees, equity decreases by $10. The expanded equation is:

```
Assets = Liabilities + Equity + (Revenue - Expenses)
```

Every journal entry you create must preserve this equation. The balancing trigger we build later enforces this at the database level.

> **Key Term:** **The Accounting Equation** -- Assets = Liabilities + Equity. This equation must hold true at all times. Every double-entry transaction preserves it by debiting one side and crediting the other by equal amounts. If a database query ever shows this equation is unbalanced, you have a data integrity problem.

### Debits and Credits: The Part Everyone Gets Wrong

Here is where most developers get confused. "Debit" does not mean "money goes out" and "credit" does not mean "money comes in." Those are the consumer banking definitions, and they will mislead you.

In accounting:

- A **debit** is an entry on the **left side** of an account.
- A **credit** is an entry on the **right side** of an account.

What "left" and "right" *mean* depends on the type of account:

| Account Type | Debit (Left Side) | Credit (Right Side) | Normal Balance |
|---|---|---|---|
| **Asset** (cash, receivables) | Increases the balance | Decreases the balance | Debit |
| **Expense** (costs, fees) | Increases the balance | Decreases the balance | Debit |
| **Liability** (money you owe) | Decreases the balance | Increases the balance | Credit |
| **Revenue** (money you earned) | Decreases the balance | Increases the balance | Credit |
| **Equity** (owner's stake) | Decreases the balance | Increases the balance | Credit |

> **Analogy:** Think of a bank analogy. When you deposit $100 into your bank account, from the bank's perspective, that is a *liability* -- the bank owes you $100. The bank credits your account (liability increases). At the same time, the bank debits its cash account (asset increases -- they have the cash). Both sides record the event. Both sides balance. If you withdraw $50, the bank debits your account (liability decreases) and credits its cash (asset decreases). Two entries, always balanced.

Here is the mnemonic: **assets and expenses are "debit-normal"** (their normal balance is a debit), while **liabilities, revenue, and equity are "credit-normal"** (their normal balance is a credit). When you increase a debit-normal account, you debit it. When you increase a credit-normal account, you credit it.

If this feels backwards, that is normal. It took accountants centuries to standardize this. Spend a few minutes with the table above until it clicks. Every code example in this chapter assumes you understand the table.

### Journal Entries: The Atomic Unit of Accounting

A **journal entry** is the atomic unit of accounting. It records a single economic event as a set of debits and credits that sum to zero. Every financial event in our system -- a payment, a refund, a commission calculation, a supplier payout -- becomes one or more journal entries.

A journal entry has three parts:

1. **Header**: The date, description, reference to the originating booking or transaction, and a status (draft or posted).
2. **Lines**: Two or more lines, each recording a debit or credit to a specific account. The total debits across all lines must equal the total credits.
3. **Immutability**: Once a journal entry is "posted" (finalized), it can never be modified or deleted. Corrections are made by creating new reversing entries.

Here is what a journal entry looks like conceptually:

```
Journal Entry: PAY-20260315-000001
Date: 2026-03-15
Description: Customer payment for booking #55012

  Account                      Debit      Credit
  --------------------------------------------------
  1210 Stripe Clearing         $340.00
  2100 Customer Deposits                   $340.00
  --------------------------------------------------
  TOTAL                        $340.00     $340.00  <-- balanced
```

The debit to Stripe Clearing (an asset) records that we now have $340 sitting in our Stripe account. The credit to Customer Deposits (a liability) records that we owe that $340 back if the customer cancels. Total debits equal total credits. The accounting equation is preserved.

> **Key Term:** **Journal Entry** -- The fundamental record in double-entry accounting. A journal entry captures a single economic event as a balanced set of debits and credits. It is analogous to a database transaction: either all lines are recorded, or none are. Once posted, it is immutable.

> **Checkpoint:** Before continuing, make sure you can answer these three questions from memory:
>
> 1. What is the accounting equation?
> 2. If you want to *increase* the balance of an asset account, do you debit or credit it?
> 3. Why is a customer payment recorded as a liability and not as revenue?

---

## The Chart of Accounts: Your Financial Map

Before you can record any transaction, you need a **chart of accounts** -- a master list of every "bucket" money can flow into or out of. Think of it as an enum of financial categories, but stored in a database table so it can evolve over time.

### The SQL Schema

```sql
-- The master list of all financial accounts in our system
CREATE TABLE chart_of_accounts (
    account_code    VARCHAR(50) PRIMARY KEY,
    account_name    VARCHAR(255) NOT NULL,
    account_type    ENUM('asset', 'liability', 'revenue', 'expense', 'equity') NOT NULL,
    parent_account  VARCHAR(50),
    is_active       BOOLEAN DEFAULT TRUE,
    is_system_account BOOLEAN DEFAULT FALSE,
    currency        CHAR(3) DEFAULT 'USD',
    description     TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (parent_account) REFERENCES chart_of_accounts(account_code),
    INDEX idx_type (account_type),
    INDEX idx_parent (parent_account)
);
```

### The Prisma Schema

Every raw SQL table in this chapter has a corresponding Prisma schema and Prisma Client example. Here is the first.

```prisma
// schema.prisma

enum AccountType {
  asset
  liability
  revenue
  expense
  equity
}

model ChartOfAccounts {
  accountCode     String        @id @map("account_code") @db.VarChar(50)
  accountName     String        @map("account_name") @db.VarChar(255)
  accountType     AccountType   @map("account_type")
  parentAccount   String?       @map("parent_account") @db.VarChar(50)
  isActive        Boolean       @default(true) @map("is_active")
  isSystemAccount Boolean       @default(false) @map("is_system_account")
  currency        String        @default("USD") @db.Char(3)
  description     String?       @db.Text
  createdAt       DateTime      @default(now()) @map("created_at")
  updatedAt       DateTime      @updatedAt @map("updated_at")

  // Self-relation for hierarchy
  parent          ChartOfAccounts?  @relation("AccountHierarchy", fields: [parentAccount], references: [accountCode])
  children        ChartOfAccounts[] @relation("AccountHierarchy")

  // Relation to entry lines
  entryLines      AccountingEntryLine[]

  @@index([accountType])
  @@index([parentAccount])
  @@map("chart_of_accounts")
}
```

```typescript
// Prisma Client: Creating an account
await prisma.chartOfAccounts.create({
  data: {
    accountCode: '1210',
    accountName: 'Stripe Clearing',
    accountType: 'asset',
    parentAccount: '1200',
    isSystemAccount: true,
    currency: 'USD',
    description: 'Money in transit at Stripe',
  },
});

// Prisma Client: Fetching all asset accounts
const assetAccounts = await prisma.chartOfAccounts.findMany({
  where: { accountType: 'asset', isActive: true },
  orderBy: { accountCode: 'asc' },
});
```

### The Account Code Convention

The `account_code` uses a numeric convention borrowed from standard accounting practice:

- **1000-1999**: Assets (things we have or are owed)
- **2000-2999**: Liabilities (things we owe to others)
- **3000-3999**: Equity (owner's stake)
- **4000-4999**: Revenue (money we earned)
- **5000-5999**: Expenses (money we spent)

### The Full Chart of Accounts for Our Booking Platform

```sql
INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, parent_account, is_system_account, description) VALUES
-- =========================================
-- Assets (1000-1999): Things we HAVE or are OWED
-- =========================================
('1000', 'Cash and Cash Equivalents',     'asset', NULL,   TRUE, 'Top-level cash accounts'),
('1010', 'Operating Bank Account',        'asset', '1000', TRUE, 'Primary business bank account'),
('1100', 'Accounts Receivable',           'asset', NULL,   TRUE, 'Money owed to us'),
('1110', 'Customer Receivables',          'asset', '1100', TRUE, 'Money customers owe us'),
('1200', 'Payment Gateway Clearing',      'asset', NULL,   TRUE, 'Money in transit at payment providers'),
('1210', 'Stripe Clearing',              'asset', '1200', TRUE, 'Money in transit at Stripe'),
('1220', 'PayPal Clearing',              'asset', '1200', TRUE, 'Money in transit at PayPal'),
('1230', 'Adyen Clearing',               'asset', '1200', TRUE, 'Money in transit at Adyen'),
('1300', 'Prepaid Expenses',              'asset', NULL,   TRUE, 'Expenses paid in advance'),
('1400', 'Tax Receivables',              'asset', NULL,   TRUE, 'Tax credits and refunds owed to us'),

-- =========================================
-- Liabilities (2000-2999): Things we OWE
-- =========================================
('2000', 'Accounts Payable',              'liability', NULL,   TRUE, 'Money we owe generally'),
('2100', 'Customer Deposits',             'liability', NULL,   TRUE, 'Money customers gave us that we might refund'),
('2110', 'Unearned Revenue',              'liability', '2100', TRUE, 'Revenue not yet earned'),
('2200', 'Supplier Payables',             'liability', NULL,   TRUE, 'Money we owe suppliers'),
('2210', 'Hotel Suppliers Payable',       'liability', '2200', TRUE, 'Money owed to hotel partners'),
('2220', 'Flight Suppliers Payable',      'liability', '2200', TRUE, 'Money owed to airline partners'),
('2230', 'Car Rental Suppliers Payable',  'liability', '2200', TRUE, 'Money owed to car rental partners'),
('2300', 'Refunds Payable',               'liability', NULL,   TRUE, 'Approved refunds not yet disbursed'),
('2400', 'Tax Payables',                  'liability', NULL,   TRUE, 'Taxes collected, not yet remitted'),
('2410', 'VAT Payable',                   'liability', '2400', TRUE, 'Value-added tax collected'),
('2420', 'Sales Tax Payable',             'liability', '2400', TRUE, 'Sales tax collected'),
('2430', 'Withholding Tax Payable',       'liability', '2400', TRUE, 'Withholding tax on supplier payments'),

-- =========================================
-- Equity (3000-3999): Owner's stake
-- =========================================
('3000', 'Shareholders Equity',           'equity', NULL,   TRUE, 'Total equity'),
('3100', 'Retained Earnings',             'equity', '3000', TRUE, 'Accumulated profits'),

-- =========================================
-- Revenue (4000-4999): Money we EARNED
-- =========================================
('4000', 'Operating Revenue',             'revenue', NULL,   TRUE, 'All operating revenue'),
('4100', 'Booking Revenue',               'revenue', '4000', TRUE, 'Revenue from bookings'),
('4110', 'Hotel Booking Revenue',         'revenue', '4100', TRUE, 'Revenue from hotel bookings'),
('4120', 'Flight Booking Revenue',        'revenue', '4100', TRUE, 'Revenue from flight bookings'),
('4130', 'Car Rental Revenue',            'revenue', '4100', TRUE, 'Revenue from car rentals'),
('4200', 'Service Fees',                  'revenue', '4000', TRUE, 'Revenue from service charges'),
('4210', 'Booking Fees',                  'revenue', '4200', TRUE, 'Non-refundable booking fees'),
('4220', 'Cancellation Fees',             'revenue', '4200', TRUE, 'Fees charged on cancellations'),
('4230', 'Currency Conversion Fees',      'revenue', '4200', TRUE, 'Markup on FX conversions'),

-- =========================================
-- Expenses (5000-5999): Money we SPENT
-- =========================================
('5000', 'Operating Expenses',            'expense', NULL,   TRUE, 'All operating expenses'),
('5100', 'Cost of Sales',                 'expense', '5000', TRUE, 'Direct cost of bookings'),
('5110', 'Hotel Costs',                   'expense', '5100', TRUE, 'Amounts paid to hotels'),
('5120', 'Flight Costs',                  'expense', '5100', TRUE, 'Amounts paid to airlines'),
('5130', 'Car Rental Costs',              'expense', '5100', TRUE, 'Amounts paid to car rental companies'),
('5200', 'Payment Processing Fees',       'expense', '5000', TRUE, 'Fees paid to payment processors'),
('5210', 'Credit Card Fees',              'expense', '5200', TRUE, 'Visa/MC/Amex processing fees'),
('5220', 'PayPal Fees',                   'expense', '5200', TRUE, 'PayPal processing fees'),
('5230', 'Adyen Fees',                    'expense', '5200', TRUE, 'Adyen processing fees'),
('5300', 'Refunds and Chargebacks',       'expense', '5000', TRUE, 'Cost of refunds and disputes'),
('5310', 'Customer Refunds',              'expense', '5300', TRUE, 'Refunds issued to customers'),
('5320', 'Chargeback Losses',             'expense', '5300', TRUE, 'Losses from payment disputes'),
('5400', 'Tax Expenses',                  'expense', '5000', TRUE, 'Tax-related expenses'),
('5410', 'Irrecoverable VAT',            'expense', '5400', TRUE, 'VAT that cannot be reclaimed');
```

Notice the hierarchy. Account `1200` (Payment Gateway Clearing) is the parent of `1210` (Stripe Clearing), `1220` (PayPal Clearing), and `1230` (Adyen Clearing). This lets you see totals at different levels: "How much money is sitting at all payment gateways?" or "How much specifically at Stripe?"

> **Key Term:** **Chart of Accounts** -- The complete, organized listing of every account used in an organization's accounting system. Think of it as the schema for your financial data. Just as your database has tables, your ledger has accounts.

> **Key Term:** **Clearing Account** -- A temporary holding account for money that is "in transit." When a customer pays via Stripe, the money does not appear in your bank account instantly. It sits in Stripe's system for a day or two. The clearing account tracks this in-transit money.

---

## The Accounting Entry Tables: Where Transactions Live

Now we need the tables that actually record transactions. The design uses a **header/lines** pattern: one header table for the entry metadata, and a lines table for the individual debits and credits.

### The Entry Header

```sql
CREATE TABLE accounting_entries (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    entry_number    VARCHAR(50) NOT NULL UNIQUE,
    entry_date      DATE NOT NULL,
    entry_type      ENUM('journal', 'payment', 'refund', 'adjustment', 'reversal') NOT NULL,
    booking_id      BIGINT,
    transaction_id  BIGINT,
    user_id         BIGINT,
    description     TEXT,
    is_posted       BOOLEAN DEFAULT FALSE,
    posted_at       TIMESTAMP NULL,
    posted_by       BIGINT,
    idempotency_key VARCHAR(255) UNIQUE,
    reversed_by     BIGINT NULL,
    reversal_of     BIGINT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by      BIGINT,

    CONSTRAINT chk_posted_immutable CHECK (
        is_posted = FALSE OR
        (is_posted = TRUE AND posted_at IS NOT NULL)
    ),

    INDEX idx_booking (booking_id),
    INDEX idx_transaction (transaction_id),
    INDEX idx_date (entry_date),
    INDEX idx_posted (is_posted, posted_at),
    INDEX idx_idempotency (idempotency_key)
);
```

Two new columns compared to the original: `idempotency_key` ensures we never record the same financial event twice (critical for webhook handling), and `reversed_by`/`reversal_of` create a chain between original entries and their reversals.

The `is_posted` flag is critical. When an entry is first created, it is a **draft** (`is_posted = FALSE`). You can still add or modify lines. Once you post it (`is_posted = TRUE`), it becomes **immutable** -- it can never be changed again. If you made a mistake, you create a new *reversing* entry. This is how real accounting systems work: you never erase history.

### The Entry Lines

```sql
CREATE TABLE accounting_entry_lines (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    entry_id        BIGINT NOT NULL,
    line_number     SMALLINT NOT NULL,
    account_code    VARCHAR(50) NOT NULL,
    debit_amount    BIGINT NOT NULL DEFAULT 0,
    credit_amount   BIGINT NOT NULL DEFAULT 0,
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    exchange_rate   DECIMAL(18,8) DEFAULT 1.00000000,
    base_currency_amount BIGINT NOT NULL DEFAULT 0,
    description     TEXT,
    reference_type  VARCHAR(50),
    reference_id    BIGINT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

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

**Critical change from the original**: `debit_amount` and `credit_amount` are now `BIGINT` instead of `DECIMAL(12,2)`. We store amounts in the **smallest currency unit** -- cents for USD, pence for GBP. This eliminates floating-point rounding errors entirely. $340.00 is stored as `34000`. We will cover this in detail in the Currency Handling section.

Study the `chk_debit_or_credit` constraint. It enforces that every line is *either* a debit *or* a credit -- never both, never neither. This is the database enforcing accounting rules. You could also enforce this in application code, but putting it in the database means no bug, no API exploit, and no manual SQL can violate it.

Also notice `ON DELETE RESTRICT` on the foreign key. You cannot delete an entry that has lines. And as we will see shortly, you cannot delete a *posted* entry at all. Immutability is enforced at every level.

### The Prisma Schema for Entries and Lines

```prisma
enum EntryType {
  journal
  payment
  refund
  adjustment
  reversal
}

model AccountingEntry {
  id              BigInt      @id @default(autoincrement())
  entryNumber     String      @unique @map("entry_number") @db.VarChar(50)
  entryDate       DateTime    @map("entry_date") @db.Date
  entryType       EntryType   @map("entry_type")
  bookingId       BigInt?     @map("booking_id")
  transactionId   BigInt?     @map("transaction_id")
  userId          BigInt?     @map("user_id")
  description     String?     @db.Text
  isPosted        Boolean     @default(false) @map("is_posted")
  postedAt        DateTime?   @map("posted_at")
  postedBy        BigInt?     @map("posted_by")
  idempotencyKey  String?     @unique @map("idempotency_key") @db.VarChar(255)
  reversedBy      BigInt?     @map("reversed_by")
  reversalOf      BigInt?     @map("reversal_of")
  createdAt       DateTime    @default(now()) @map("created_at")
  createdBy       BigInt?     @map("created_by")

  // Relations
  lines           AccountingEntryLine[]
  reversalEntry   AccountingEntry?  @relation("EntryReversal", fields: [reversalOf], references: [id])
  reversedEntries AccountingEntry[] @relation("EntryReversal")

  @@index([bookingId])
  @@index([transactionId])
  @@index([entryDate])
  @@index([isPosted, postedAt])
  @@map("accounting_entries")
}

model AccountingEntryLine {
  id                  BigInt    @id @default(autoincrement())
  entryId             BigInt    @map("entry_id")
  lineNumber          Int       @map("line_number") @db.SmallInt
  accountCode         String    @map("account_code") @db.VarChar(50)
  debitAmount         BigInt    @default(0) @map("debit_amount")
  creditAmount        BigInt    @default(0) @map("credit_amount")
  currency            String    @default("USD") @db.Char(3)
  exchangeRate        Decimal   @default(1.00000000) @map("exchange_rate") @db.Decimal(18, 8)
  baseCurrencyAmount  BigInt    @default(0) @map("base_currency_amount")
  description         String?   @db.Text
  referenceType       String?   @map("reference_type") @db.VarChar(50)
  referenceId         BigInt?   @map("reference_id")
  createdAt           DateTime  @default(now()) @map("created_at")

  // Relations
  entry               AccountingEntry   @relation(fields: [entryId], references: [id], onDelete: Restrict)
  account             ChartOfAccounts   @relation(fields: [accountCode], references: [accountCode])

  @@index([entryId, lineNumber])
  @@index([accountCode])
  @@map("accounting_entry_lines")
}
```

```typescript
// Prisma Client: Creating a complete journal entry with lines
const entry = await prisma.accountingEntry.create({
  data: {
    entryNumber: 'PAY-20260315-000001',
    entryDate: new Date('2026-03-15'),
    entryType: 'payment',
    bookingId: 55012n,
    description: 'Customer payment for booking #55012',
    idempotencyKey: 'pay_booking_55012_stripe_pi_abc123',
    lines: {
      create: [
        {
          lineNumber: 1,
          accountCode: '1210',
          debitAmount: 34000n,    // $340.00 in cents
          creditAmount: 0n,
          currency: 'USD',
          description: 'Payment received via Stripe',
          referenceType: 'transaction',
          referenceId: 1001n,
        },
        {
          lineNumber: 2,
          accountCode: '2100',
          debitAmount: 0n,
          creditAmount: 34000n,   // $340.00 in cents
          currency: 'USD',
          description: 'Customer deposit for booking',
          referenceType: 'booking',
          referenceId: 55012n,
        },
      ],
    },
  },
  include: { lines: true },
});
```

> **Analogy:** Think of the header (accounting_entries) as a folder, and the lines (accounting_entry_lines) as papers inside that folder. Each folder is labeled with a date, type, and description. Inside the folder are exactly the papers (debits and credits) that document what happened. Once you stamp the folder as "POSTED," you lock it in a filing cabinet and nobody takes it out again. If you made a mistake, you create a new folder labeled "Reversal of Folder #42."

### The Transactions Table

In addition to the accounting entries, we need a `transactions` table that tracks the lifecycle of each payment at the payment provider level. This table connects the external world (Stripe, Adyen) to our internal ledger.

```sql
CREATE TABLE transactions (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    booking_id          BIGINT NOT NULL,
    user_id             BIGINT NOT NULL,
    provider            VARCHAR(50) NOT NULL,
    provider_txn_id     VARCHAR(255),
    idempotency_key     VARCHAR(255) NOT NULL UNIQUE,
    amount              BIGINT NOT NULL,
    currency            CHAR(3) NOT NULL DEFAULT 'USD',
    status              ENUM('pending', 'authorized', 'captured', 'voided',
                             'refund_pending', 'refunded', 'partially_refunded',
                             'failed', 'disputed') NOT NULL DEFAULT 'pending',
    payment_method_type VARCHAR(50),
    last_four           CHAR(4),
    authorized_at       TIMESTAMP NULL,
    captured_at         TIMESTAMP NULL,
    refunded_at         TIMESTAMP NULL,
    refund_amount       BIGINT DEFAULT 0,
    failure_reason      TEXT,
    metadata            JSON,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_booking (booking_id),
    INDEX idx_provider_txn (provider, provider_txn_id),
    INDEX idx_status (status),
    INDEX idx_idempotency (idempotency_key)
);
```

```prisma
enum TransactionStatus {
  pending
  authorized
  captured
  voided
  refund_pending
  refunded
  partially_refunded
  failed
  disputed
}

model Transaction {
  id                BigInt            @id @default(autoincrement())
  bookingId         BigInt            @map("booking_id")
  userId            BigInt            @map("user_id")
  provider          String            @db.VarChar(50)
  providerTxnId     String?           @map("provider_txn_id") @db.VarChar(255)
  idempotencyKey    String            @unique @map("idempotency_key") @db.VarChar(255)
  amount            BigInt
  currency          String            @default("USD") @db.Char(3)
  status            TransactionStatus @default(pending)
  paymentMethodType String?           @map("payment_method_type") @db.VarChar(50)
  lastFour          String?           @map("last_four") @db.Char(4)
  authorizedAt      DateTime?         @map("authorized_at")
  capturedAt        DateTime?         @map("captured_at")
  refundedAt        DateTime?         @map("refunded_at")
  refundAmount      BigInt            @default(0) @map("refund_amount")
  failureReason     String?           @map("failure_reason") @db.Text
  metadata          Json?
  createdAt         DateTime          @default(now()) @map("created_at")
  updatedAt         DateTime          @updatedAt @map("updated_at")

  @@index([bookingId])
  @@index([provider, providerTxnId])
  @@index([status])
  @@map("transactions")
}
```

### The Ledger Entries Table (Audit Trail)

Finally, the `ledger_entries` table provides an **append-only audit log** of every financial state change. Unlike accounting entries (which record balanced debits and credits), ledger entries record *events*: "payment authorized," "capture succeeded," "refund initiated." This is the table an auditor reads to understand the timeline of every dollar.

```sql
CREATE TABLE ledger_entries (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    transaction_id  BIGINT NOT NULL,
    booking_id      BIGINT NOT NULL,
    event_type      VARCHAR(100) NOT NULL,
    amount          BIGINT NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    balance_before  BIGINT,
    balance_after   BIGINT,
    provider        VARCHAR(50),
    provider_txn_id VARCHAR(255),
    description     TEXT,
    actor_type      ENUM('system', 'user', 'admin', 'webhook') NOT NULL DEFAULT 'system',
    actor_id        VARCHAR(255),
    ip_address      VARCHAR(45),
    metadata        JSON,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- No UPDATE or DELETE triggers needed: this table is append-only.
    -- Application code must NEVER issue UPDATE or DELETE on this table.

    INDEX idx_transaction (transaction_id),
    INDEX idx_booking (booking_id),
    INDEX idx_event (event_type),
    INDEX idx_created (created_at)
);
```

```prisma
enum ActorType {
  system
  user
  admin
  webhook
}

model LedgerEntry {
  id              BigInt    @id @default(autoincrement())
  transactionId   BigInt    @map("transaction_id")
  bookingId       BigInt    @map("booking_id")
  eventType       String    @map("event_type") @db.VarChar(100)
  amount          BigInt
  currency        String    @default("USD") @db.Char(3)
  balanceBefore   BigInt?   @map("balance_before")
  balanceAfter    BigInt?   @map("balance_after")
  provider        String?   @db.VarChar(50)
  providerTxnId   String?   @map("provider_txn_id") @db.VarChar(255)
  description     String?   @db.Text
  actorType       ActorType @default(system) @map("actor_type")
  actorId         String?   @map("actor_id") @db.VarChar(255)
  ipAddress       String?   @map("ip_address") @db.VarChar(45)
  metadata        Json?
  createdAt       DateTime  @default(now()) @map("created_at")

  @@index([transactionId])
  @@index([bookingId])
  @@index([eventType])
  @@index([createdAt])
  @@map("ledger_entries")
}
```

```typescript
// Prisma Client: Recording an audit event
await prisma.ledgerEntry.create({
  data: {
    transactionId: 1001n,
    bookingId: 55012n,
    eventType: 'payment.captured',
    amount: 34000n,
    currency: 'USD',
    provider: 'stripe',
    providerTxnId: 'pi_abc123',
    description: 'Payment captured successfully',
    actorType: 'webhook',
    actorId: 'stripe_webhook_evt_xyz',
    metadata: {
      stripeEventId: 'evt_xyz789',
      captureTimestamp: '2026-03-15T14:30:00Z',
    },
  },
});
```

> **What If You Skip This?** Without the ledger_entries table, you lose the timeline. The accounting entries tell you the final state ("$340 was debited to Stripe Clearing"), but not the journey ("payment was authorized at 14:28, captured at 14:30, settlement initiated at 02:00 the next day"). When a customer disputes a charge, you need both.

---

## The Balanced Entry Trigger: The Database Enforces Accounting

We have a CHECK constraint that forces every line to be a debit or a credit. But who checks that the total debits equal the total credits? A MySQL trigger.

```sql
DELIMITER //

CREATE TRIGGER validate_balanced_entry_before_post
BEFORE UPDATE ON accounting_entries
FOR EACH ROW
BEGIN
    -- IMPORTANT: In MySQL, ALL DECLARE statements must appear at the
    -- very top of a BEGIN block, before any IF or other statements.
    DECLARE v_total_debit BIGINT;
    DECLARE v_total_credit BIGINT;

    -- Only validate when we are POSTING an entry (changing is_posted
    -- from FALSE to TRUE). We do not care about other updates.
    IF NEW.is_posted = TRUE AND OLD.is_posted = FALSE THEN

        -- Sum up all debits and credits for this entry's lines
        SELECT COALESCE(SUM(debit_amount), 0), COALESCE(SUM(credit_amount), 0)
        INTO v_total_debit, v_total_credit
        FROM accounting_entry_lines
        WHERE entry_id = NEW.id;

        -- THE FUNDAMENTAL ACCOUNTING EQUATION: Debits = Credits
        -- Since we store amounts as integers (cents), exact equality is expected.
        -- No floating-point tolerance needed.
        IF v_total_debit != v_total_credit THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = CONCAT(
                'Accounting entry is not balanced. ',
                'Debits: ', v_total_debit, ', ',
                'Credits: ', v_total_credit
            );
        END IF;

        -- Every entry needs at least 2 lines: one debit and one credit.
        IF (SELECT COUNT(*) FROM accounting_entry_lines
            WHERE entry_id = NEW.id) < 2 THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Accounting entry must have at least 2 lines (debit and credit)';
        END IF;

        -- Auto-set the posted timestamp.
        SET NEW.posted_at = NOW();
    END IF;
END//

DELIMITER ;
```

Notice an important difference from the original version: because we now store amounts as `BIGINT` (cents), we use **exact equality** (`v_total_debit != v_total_credit`) instead of a floating-point tolerance. This is one of the major benefits of integer-based currency storage -- no rounding tolerance needed, no edge cases.

> **Common Mistake: DECLARE Position in MySQL Triggers.**
> In MySQL stored programs, all `DECLARE` statements **must** appear at the very top of the `BEGIN` block, before any `IF`, `SELECT`, or other statements. If you write `IF ... THEN DECLARE ...`, MySQL throws a syntax error that looks like `You have an error in your SQL syntax near 'DECLARE'`. This is a MySQL-specific rule. PostgreSQL does not have this restriction.

---

## Immutability Triggers: Locking the Books

Once an entry is posted, it must never be modified or deleted. This is not a suggestion. It is a legal and regulatory requirement for any financial system.

```sql
DELIMITER //

-- Trigger 1: Prevent modification of posted entries
CREATE TRIGGER prevent_posted_entry_modification
BEFORE UPDATE ON accounting_entries
FOR EACH ROW
BEGIN
    IF OLD.is_posted = TRUE AND NEW.is_posted = TRUE THEN
        -- Allow only the 'reversed_by' field to be set on a posted entry.
        -- This links the original to its reversal without modifying financial data.
        IF NOT (OLD.reversed_by IS NULL AND NEW.reversed_by IS NOT NULL
                AND OLD.entry_number = NEW.entry_number
                AND OLD.entry_date = NEW.entry_date
                AND OLD.entry_type = NEW.entry_type
                AND OLD.booking_id <=> NEW.booking_id
                AND OLD.description <=> NEW.description) THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Cannot modify a posted accounting entry. Create a reversing entry instead.';
        END IF;
    END IF;
END//

-- Trigger 2: Prevent deletion of posted entries
CREATE TRIGGER prevent_posted_entry_deletion
BEFORE DELETE ON accounting_entries
FOR EACH ROW
BEGIN
    IF OLD.is_posted = TRUE THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Cannot delete a posted accounting entry. Create a reversing entry instead.';
    END IF;
END//

-- Trigger 3: Prevent modification of lines belonging to posted entries
CREATE TRIGGER prevent_posted_line_modification
BEFORE UPDATE ON accounting_entry_lines
FOR EACH ROW
BEGIN
    DECLARE v_is_posted BOOLEAN;
    SELECT is_posted INTO v_is_posted
    FROM accounting_entries WHERE id = OLD.entry_id;

    IF v_is_posted = TRUE THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Cannot modify lines of a posted accounting entry.';
    END IF;
END//

-- Trigger 4: Prevent deletion of lines belonging to posted entries
CREATE TRIGGER prevent_posted_line_deletion
BEFORE DELETE ON accounting_entry_lines
FOR EACH ROW
BEGIN
    DECLARE v_is_posted BOOLEAN;
    SELECT is_posted INTO v_is_posted
    FROM accounting_entries WHERE id = OLD.entry_id;

    IF v_is_posted = TRUE THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Cannot delete lines of a posted accounting entry.';
    END IF;
END//

DELIMITER ;
```

The modification trigger is more nuanced than before. It allows setting the `reversed_by` field on a posted entry -- this is necessary to link original entries to their reversals. But it checks that no other fields are being changed. The `<=>` operator is MySQL's null-safe equality check: `NULL <=> NULL` returns TRUE, unlike `NULL = NULL` which returns NULL.

Triggers 3 and 4 are new. The original design only protected the header table. But an attacker or bug could still modify or delete the *lines* of a posted entry. Now the lines are protected too.

> **What If You Skip This?** Without immutability at the database level, any application bug or malicious query can alter financial history. "But my application code checks permissions before allowing edits." Good. But what about the developer who runs a manual SQL query during an incident? What about the ORM bug that issues an unexpected UPDATE? Database-level triggers are your last line of defense. When an auditor asks "can anyone in your organization alter a posted financial record?" your answer needs to be "no, the database literally prevents it."

---

## The Entry Number Generator

Every accounting entry needs a unique, human-readable number. The format is:

```
{type prefix}-{YYYYMMDD}-{sequence}

Examples:
  PAY-20260315-000001   (first payment entry on March 15, 2026)
  REF-20260315-000001   (first refund entry on that day)
  JNL-20260316-000001   (first journal entry on March 16 -- sequence resets daily)
```

```sql
CREATE TABLE entry_number_sequences (
    entry_type      VARCHAR(20) NOT NULL,
    entry_date      DATE NOT NULL,
    next_sequence   INT NOT NULL DEFAULT 1,
    PRIMARY KEY (entry_type, entry_date)
);
```

```typescript
private async generateEntryNumber(entryType: string): Promise<string> {
  const prefixMap: Record<string, string> = {
    payment: 'PAY', refund: 'REF', reversal: 'REV',
    journal: 'JNL', adjustment: 'ADJ',
  };
  const prefix = prefixMap[entryType] || 'JNL';
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // ATOMIC INCREMENT using INSERT ... ON DUPLICATE KEY UPDATE
  await db.execute(`
    INSERT INTO entry_number_sequences (entry_type, entry_date, next_sequence)
    VALUES (?, CURDATE(), 2)
    ON DUPLICATE KEY UPDATE next_sequence = next_sequence + 1
  `, [entryType]);

  const [rows] = await db.execute(`
    SELECT next_sequence - 1 AS seq
    FROM entry_number_sequences
    WHERE entry_type = ? AND entry_date = CURDATE()
  `, [entryType]);

  const seq = String(rows[0].seq).padStart(6, '0');
  return `${prefix}-${today}-${seq}`;
}
```

**Why `INSERT ... ON DUPLICATE KEY UPDATE`?** This MySQL idiom is an "upsert" -- insert if the row does not exist, update if it does. It is a single atomic operation. Two requests hitting the database at the exact same millisecond will get different sequence numbers because MySQL serializes the writes internally. No application-level locking needed.

---

## Recording a Customer Payment: Step-by-Step Journal Entries

When a customer pays $340 for a hotel booking via Stripe, we create a journal entry with two lines:

1. **Debit** the Stripe Clearing account (asset increases -- we have $340 at Stripe)
2. **Credit** the Customer Deposits account (liability increases -- we owe the $340 back if the customer cancels)

Notice: this is NOT revenue yet. The $340 is a *deposit* -- a liability.

### The Raw SQL + TypeScript Approach

```typescript
export class AccountingService {

  async recordCustomerPayment(params: {
    bookingId: bigint;
    transactionId: bigint;
    amount: number;         // in dollars: 340.00
    currency: string;
    paymentProvider: string;
  }): Promise<void> {

    // Convert dollars to cents IMMEDIATELY at the boundary
    const amountCents = Math.round(params.amount * 100);

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const entryNumber = await this.generateEntryNumber('payment');
      const idempotencyKey = `pay_${params.bookingId}_${params.transactionId}`;

      // Check idempotency: has this payment already been recorded?
      const [existing] = await connection.execute(
        'SELECT id FROM accounting_entries WHERE idempotency_key = ?',
        [idempotencyKey]
      );
      if (existing.length > 0) {
        await connection.rollback();
        return; // Already recorded. Safe to return.
      }

      // Create the entry header
      const [paymentResult] = await connection.execute(`
        INSERT INTO accounting_entries (
          entry_number, entry_date, entry_type,
          booking_id, transaction_id, description,
          idempotency_key, created_by
        ) VALUES (?, CURDATE(), 'payment', ?, ?, ?, ?, ?)
      `, [entryNumber, params.bookingId, params.transactionId,
          `Customer payment of ${params.currency} ${params.amount} for booking ${params.bookingId}`,
          idempotencyKey, null]);

      const entryId = paymentResult.insertId;

      // LINE 1: Debit the Payment Gateway Clearing account
      // Asset account. Debit = increase.
      // "We now have $340 sitting at Stripe."
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, currency,
          base_currency_amount,
          description, reference_type, reference_id
        ) VALUES (?, 1, ?, ?, 0, ?, ?, ?, 'transaction', ?)
      `, [entryId,
          this.getPaymentGatewayAccount(params.paymentProvider),
          amountCents, params.currency, amountCents,
          `Payment received via ${params.paymentProvider}`,
          params.transactionId]);

      // LINE 2: Credit the Customer Deposits account
      // Liability account. Credit = increase.
      // "We owe this $340 back if the customer cancels."
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, currency,
          base_currency_amount,
          description, reference_type, reference_id
        ) VALUES (?, 2, '2100', 0, ?, ?, ?, ?, 'booking', ?)
      `, [entryId, amountCents, params.currency, amountCents,
          'Customer deposit for booking', params.bookingId]);

      // POST the entry -- triggers balance validation
      await connection.execute(
        'UPDATE accounting_entries SET is_posted = TRUE WHERE id = ?',
        [entryId]
      );

      // Record in audit trail
      await connection.execute(`
        INSERT INTO ledger_entries (
          transaction_id, booking_id, event_type,
          amount, currency, provider, description, actor_type
        ) VALUES (?, ?, 'payment.recorded', ?, ?, ?, ?, 'system')
      `, [params.transactionId, params.bookingId, amountCents,
          params.currency, params.paymentProvider,
          `Journal entry ${entryNumber} posted for customer payment`]);

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
```

### The Prisma Client Approach

Here is the same operation using Prisma Client with interactive transactions.

```typescript
async recordCustomerPayment(params: {
  bookingId: bigint;
  transactionId: bigint;
  amount: number;
  currency: string;
  paymentProvider: string;
}): Promise<void> {

  const amountCents = BigInt(Math.round(params.amount * 100));
  const idempotencyKey = `pay_${params.bookingId}_${params.transactionId}`;

  await prisma.$transaction(async (tx) => {
    // Idempotency check
    const existing = await tx.accountingEntry.findUnique({
      where: { idempotencyKey },
    });
    if (existing) return;

    const entryNumber = await this.generateEntryNumber('payment');
    const gatewayAccount = this.getPaymentGatewayAccount(params.paymentProvider);

    // Create entry with lines in a single Prisma call
    const entry = await tx.accountingEntry.create({
      data: {
        entryNumber,
        entryDate: new Date(),
        entryType: 'payment',
        bookingId: params.bookingId,
        transactionId: params.transactionId,
        description: `Customer payment of ${params.currency} ${params.amount} for booking ${params.bookingId}`,
        idempotencyKey,
        lines: {
          create: [
            {
              lineNumber: 1,
              accountCode: gatewayAccount,
              debitAmount: amountCents,
              creditAmount: 0n,
              currency: params.currency,
              baseCurrencyAmount: amountCents,
              description: `Payment received via ${params.paymentProvider}`,
              referenceType: 'transaction',
              referenceId: params.transactionId,
            },
            {
              lineNumber: 2,
              accountCode: '2100',
              debitAmount: 0n,
              creditAmount: amountCents,
              currency: params.currency,
              baseCurrencyAmount: amountCents,
              description: 'Customer deposit for booking',
              referenceType: 'booking',
              referenceId: params.bookingId,
            },
          ],
        },
      },
    });

    // Post the entry (triggers balance validation via raw SQL trigger)
    await tx.accountingEntry.update({
      where: { id: entry.id },
      data: { isPosted: true },
    });

    // Audit trail
    await tx.ledgerEntry.create({
      data: {
        transactionId: params.transactionId,
        bookingId: params.bookingId,
        eventType: 'payment.recorded',
        amount: amountCents,
        currency: params.currency,
        provider: params.paymentProvider,
        description: `Journal entry ${entryNumber} posted for customer payment`,
        actorType: 'system',
      },
    });
  });
}
```

Here is what the resulting data looks like in the database:

**accounting_entries:**

| id | entry_number | entry_date | entry_type | booking_id | is_posted | idempotency_key |
|---|---|---|---|---|---|---|
| 1 | PAY-20260315-000001 | 2026-03-15 | payment | 55012 | TRUE | pay_55012_1001 |

**accounting_entry_lines:**

| entry_id | line | account_code | debit | credit | description |
|---|---|---|---|---|---|
| 1 | 1 | 1210 (Stripe Clearing) | 34000 | 0 | Payment received via stripe |
| 1 | 2 | 2100 (Customer Deposits) | 0 | 34000 | Customer deposit for booking |

Total debits: 34000. Total credits: 34000. Balanced. The trigger approved it.

> **Checkpoint:** Trace through the code and answer: what happens if Stripe's webhook fires twice for the same payment? Which line of code prevents a duplicate journal entry?

---

## Revenue Recognition: When the Deposit Becomes Revenue

The customer paid $340, but that is not our revenue yet. Why? Because the guest has not checked in. If they cancel tomorrow, we refund them. Revenue is recognized when the service is delivered -- typically at check-in or check-out, depending on your accounting policy.

> **Key Term:** **Revenue Recognition** -- The accounting principle that determines when income is recorded as "earned." In our booking system, a customer payment is initially recorded as a liability (Customer Deposits), not as revenue. It becomes revenue only when the service is delivered (the guest checks in). This timing distinction matters for accurate financial reporting and regulatory compliance.

When we recognize revenue, two things happen as **separate journal entries**:

**Entry 1: Revenue Recognition** -- Transfer money from the Customer Deposits (liability) to Booking Revenue (revenue). The liability decreases and revenue increases.

**Entry 2: Cost Accrual** -- Record what we owe the hotel (supplier). The Cost of Sales (expense) increases and the Supplier Payable (liability) increases.

> **Common Mistake: Mixing Revenue and Cost in One Journal Entry.**
> An earlier version of this system combined revenue recognition and cost accrual into a single 4-line journal entry. While technically balanced (debits = credits), this violated the accounting principle of separating distinct economic events. Revenue recognition and cost accrual are *independent* events that may occur at different times. They must be auditable separately.

```typescript
// Prisma Client: Revenue recognition with two separate entries
async recognizeBookingRevenue(params: {
  bookingId: bigint;
  bookingType: string;   // 'hotel', 'flight', or 'car'
  amount: number;        // total customer paid (e.g., 340.00)
  supplierCost: number;  // what we owe the hotel (e.g., 290.00)
}): Promise<void> {

  const amountCents = BigInt(Math.round(params.amount * 100));
  const supplierCostCents = BigInt(Math.round(params.supplierCost * 100));

  await prisma.$transaction(async (tx) => {
    // ==========================================
    // ENTRY 1: Revenue Recognition
    // "The customer's deposit is now our revenue."
    // ==========================================
    const revenueEntryNumber = await this.generateEntryNumber('journal');
    const revenueAccount = this.getRevenueAccount(params.bookingType);

    const revenueEntry = await tx.accountingEntry.create({
      data: {
        entryNumber: revenueEntryNumber,
        entryDate: new Date(),
        entryType: 'journal',
        bookingId: params.bookingId,
        description: `Revenue recognition for ${params.bookingType} booking`,
        idempotencyKey: `rev_${params.bookingId}`,
        lines: {
          create: [
            {
              lineNumber: 1,
              accountCode: '2100',        // Customer Deposits
              debitAmount: amountCents,    // Liability DECREASES
              creditAmount: 0n,
              description: 'Transfer from customer deposit',
            },
            {
              lineNumber: 2,
              accountCode: revenueAccount, // e.g., '4110' Hotel Booking Revenue
              debitAmount: 0n,
              creditAmount: amountCents,   // Revenue INCREASES
              description: 'Booking revenue recognized',
            },
          ],
        },
      },
    });

    await tx.accountingEntry.update({
      where: { id: revenueEntry.id },
      data: { isPosted: true },
    });

    // ==========================================
    // ENTRY 2: Cost Accrual
    // "We now owe the hotel $290 for providing the room."
    // ==========================================
    const costEntryNumber = await this.generateEntryNumber('journal');
    const costAccount = this.getCostAccount(params.bookingType);
    const payableAccount = this.getSupplierPayableAccount(params.bookingType);

    const costEntry = await tx.accountingEntry.create({
      data: {
        entryNumber: costEntryNumber,
        entryDate: new Date(),
        entryType: 'journal',
        bookingId: params.bookingId,
        description: `Cost accrual for ${params.bookingType} booking`,
        idempotencyKey: `cost_${params.bookingId}`,
        lines: {
          create: [
            {
              lineNumber: 1,
              accountCode: costAccount,       // e.g., '5110' Hotel Costs
              debitAmount: supplierCostCents,  // Expense INCREASES
              creditAmount: 0n,
              description: 'Supplier cost for booking',
            },
            {
              lineNumber: 2,
              accountCode: payableAccount,     // e.g., '2210' Hotel Suppliers Payable
              debitAmount: 0n,
              creditAmount: supplierCostCents, // Liability INCREASES
              description: 'Amount owed to supplier',
            },
          ],
        },
      },
    });

    await tx.accountingEntry.update({
      where: { id: costEntry.id },
      data: { isPosted: true },
    });
  });
}
```

Our gross profit on a $340 hotel booking where the hotel costs $290: **$340 - $290 = $50 commission**. And every cent is traceable through the ledger.

---

## Refund Flow: Reverse Journal Entries

Refunds are where most home-grown payment systems break down. With double-entry accounting, refunds are clean: you create a **reversing entry** that exactly negates the original, then record the actual refund disbursement.

### Full Refund

A full refund for booking #55012 requires reversing the original payment entry and issuing the refund through the payment provider.

```typescript
async processFullRefund(params: {
  bookingId: bigint;
  transactionId: bigint;
  originalAmount: number;
  currency: string;
  paymentProvider: string;
  reason: string;
  initiatedBy: bigint;     // admin or system user ID
}): Promise<void> {

  const amountCents = BigInt(Math.round(params.originalAmount * 100));

  await prisma.$transaction(async (tx) => {
    // Step 1: Find the original payment entry
    const originalEntry = await tx.accountingEntry.findFirst({
      where: {
        bookingId: params.bookingId,
        entryType: 'payment',
        isPosted: true,
        reversedBy: null,         // not already reversed
      },
      include: { lines: true },
    });

    if (!originalEntry) {
      throw new Error(`No unreversed payment entry found for booking ${params.bookingId}`);
    }

    // Step 2: Create the reversing entry
    // A reversal SWAPS debits and credits from the original.
    const reversalNumber = await this.generateEntryNumber('reversal');
    const idempotencyKey = `refund_full_${params.bookingId}_${params.transactionId}`;

    const reversalEntry = await tx.accountingEntry.create({
      data: {
        entryNumber: reversalNumber,
        entryDate: new Date(),
        entryType: 'reversal',
        bookingId: params.bookingId,
        transactionId: params.transactionId,
        description: `Full refund reversal: ${params.reason}`,
        idempotencyKey,
        reversalOf: originalEntry.id,
        createdBy: params.initiatedBy,
        lines: {
          create: [
            {
              // REVERSE of original line 1:
              // Original debited Stripe Clearing. Reversal CREDITS it.
              lineNumber: 1,
              accountCode: '1210',       // Stripe Clearing
              debitAmount: 0n,
              creditAmount: amountCents, // Asset DECREASES
              currency: params.currency,
              baseCurrencyAmount: amountCents,
              description: 'Refund: reverse payment gateway clearing',
            },
            {
              // REVERSE of original line 2:
              // Original credited Customer Deposits. Reversal DEBITS it.
              lineNumber: 2,
              accountCode: '2100',       // Customer Deposits
              debitAmount: amountCents,  // Liability DECREASES
              creditAmount: 0n,
              currency: params.currency,
              baseCurrencyAmount: amountCents,
              description: 'Refund: reverse customer deposit',
            },
          ],
        },
      },
    });

    // Step 3: Post the reversal
    await tx.accountingEntry.update({
      where: { id: reversalEntry.id },
      data: { isPosted: true },
    });

    // Step 4: Link the original to its reversal
    await tx.accountingEntry.update({
      where: { id: originalEntry.id },
      data: { reversedBy: reversalEntry.id },
    });

    // Step 5: Update the transaction status
    await tx.transaction.update({
      where: { id: params.transactionId },
      data: {
        status: 'refunded',
        refundAmount: amountCents,
        refundedAt: new Date(),
      },
    });

    // Step 6: Audit trail
    await tx.ledgerEntry.create({
      data: {
        transactionId: params.transactionId,
        bookingId: params.bookingId,
        eventType: 'refund.full',
        amount: amountCents,
        currency: params.currency,
        provider: params.paymentProvider,
        description: `Full refund processed: ${params.reason}`,
        actorType: 'admin',
        actorId: params.initiatedBy.toString(),
      },
    });
  });
}
```

### Partial Refund

Partial refunds are trickier. You cannot reverse the entire original entry -- you reverse only a portion. The journal entry still balances, but the amounts are smaller.

```typescript
async processPartialRefund(params: {
  bookingId: bigint;
  transactionId: bigint;
  refundAmount: number;      // e.g., 100.00 out of 340.00
  originalAmount: number;     // 340.00
  currency: string;
  paymentProvider: string;
  reason: string;
  initiatedBy: bigint;
}): Promise<void> {

  const refundCents = BigInt(Math.round(params.refundAmount * 100));
  const originalCents = BigInt(Math.round(params.originalAmount * 100));

  // Validate: refund cannot exceed original
  if (refundCents > originalCents) {
    throw new Error('Refund amount cannot exceed original payment amount');
  }

  // Validate: check total refunds to date for this transaction
  const existingRefunds = await prisma.accountingEntry.aggregate({
    where: {
      bookingId: params.bookingId,
      entryType: 'refund',
      isPosted: true,
    },
    _count: true,
  });

  // Sum up all previous partial refund amounts
  const previousRefundTotal = await prisma.accountingEntryLine.aggregate({
    where: {
      entry: {
        bookingId: params.bookingId,
        entryType: 'refund',
        isPosted: true,
      },
      accountCode: '2100',
      debitAmount: { gt: 0 },
    },
    _sum: { debitAmount: true },
  });

  const totalRefundedSoFar = previousRefundTotal._sum.debitAmount || 0n;
  if (totalRefundedSoFar + refundCents > originalCents) {
    throw new Error(
      `Total refunds (${totalRefundedSoFar + refundCents}) would exceed original amount (${originalCents})`
    );
  }

  await prisma.$transaction(async (tx) => {
    const refundEntryNumber = await this.generateEntryNumber('refund');
    const idempotencyKey = `refund_partial_${params.bookingId}_${params.amount}_${params.reason}`;

    const refundEntry = await tx.accountingEntry.create({
      data: {
        entryNumber: refundEntryNumber,
        entryDate: new Date(),
        entryType: 'refund',
        bookingId: params.bookingId,
        transactionId: params.transactionId,
        description: `Partial refund of ${params.currency} ${params.refundAmount}: ${params.reason}`,
        idempotencyKey,
        createdBy: params.initiatedBy,
        lines: {
          create: [
            {
              lineNumber: 1,
              accountCode: '2100',        // Customer Deposits
              debitAmount: refundCents,    // Liability DECREASES by refund amount
              creditAmount: 0n,
              currency: params.currency,
              baseCurrencyAmount: refundCents,
              description: `Partial refund: ${params.reason}`,
            },
            {
              lineNumber: 2,
              accountCode: '1210',        // Stripe Clearing
              debitAmount: 0n,
              creditAmount: refundCents,  // Asset DECREASES by refund amount
              currency: params.currency,
              baseCurrencyAmount: refundCents,
              description: 'Refund disbursement via Stripe',
            },
          ],
        },
      },
    });

    await tx.accountingEntry.update({
      where: { id: refundEntry.id },
      data: { isPosted: true },
    });

    // Determine new transaction status
    const newTotalRefunded = totalRefundedSoFar + refundCents;
    const newStatus = newTotalRefunded >= originalCents
      ? 'refunded'
      : 'partially_refunded';

    await tx.transaction.update({
      where: { id: params.transactionId },
      data: {
        status: newStatus,
        refundAmount: newTotalRefunded,
        refundedAt: new Date(),
      },
    });

    await tx.ledgerEntry.create({
      data: {
        transactionId: params.transactionId,
        bookingId: params.bookingId,
        eventType: 'refund.partial',
        amount: refundCents,
        currency: params.currency,
        provider: params.paymentProvider,
        description: `Partial refund of ${params.refundAmount} ${params.currency}: ${params.reason}`,
        actorType: 'admin',
        actorId: params.initiatedBy.toString(),
      },
    });
  });
}
```

After a $100 partial refund on the original $340 booking, the account balances are:

| Account | Before Refund | After Refund |
|---|---|---|
| 1210 Stripe Clearing (asset) | 34000 (debit balance) | 24000 (debit balance) |
| 2100 Customer Deposits (liability) | 34000 (credit balance) | 24000 (credit balance) |

The system still holds $240 at Stripe, and still owes the customer $240. Everything balances. And the refund is a separate, immutable journal entry -- the original payment entry is untouched.

> **Analogy:** A full refund is like unstamping a letter and putting it back in the outbox. A partial refund is like opening the letter, taking out some of the contents, and mailing back what you removed. In both cases, you create a new paper trail (the return receipt) rather than erasing the original mailing record.
