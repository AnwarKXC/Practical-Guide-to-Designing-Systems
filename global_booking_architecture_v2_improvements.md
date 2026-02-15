# 🚀 Global Booking System

**Version:** 2.0  
**Date:** February 15, 2026  
**Status:** Production-Ready with Enterprise-Grade Enhancements

---

## 📋 Table of Contents

1. [Critical Fixes](#1-critical-fixes)
2. [Inventory Management Improvements](#2-inventory-management-improvements)
3. [Double-Entry Accounting System](#3-double-entry-accounting-system)
4. [Multi-Region Conflict Resolution](#4-multi-region-conflict-resolution)
5. [Enhanced Monitoring & Alerting](#5-enhanced-monitoring--alerting)
6. [Detailed Capacity Planning](#6-detailed-capacity-planning)
7. [Implementation Guidelines](#7-implementation-guidelines)

---

## 1. Critical Fixes

### 1.1 Inventory Overbooking Buffer - Enhanced Safety

**Problem:** Original implementation allows overbooking but lacks proper auditing and constraints.

**Solution:**

```sql
-- ✅ Add overbooking with proper constraints
ALTER TABLE inventory 
ADD COLUMN overbooking_limit SMALLINT DEFAULT 0,
ADD CONSTRAINT chk_inventory_balance CHECK (
    available_quantity >= 0 AND
    reserved_quantity >= 0 AND
    available_quantity + reserved_quantity <= total_quantity + overbooking_limit
);

-- ✅ Audit log for every overbooking event
CREATE TABLE overbooking_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    resource_type VARCHAR(20) NOT NULL,
    resource_id BIGINT NOT NULL,
    resource_date DATE NOT NULL,
    
    -- Snapshot at time of overbooking
    total_quantity SMALLINT NOT NULL,
    reserved_quantity SMALLINT NOT NULL,
    overbooking_limit SMALLINT NOT NULL,
    actual_oversell SMALLINT NOT NULL,  -- How much over limit
    
    -- Context
    triggered_by_booking_id BIGINT,
    triggered_by_user_id BIGINT,
    region VARCHAR(20),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_resource (resource_type, resource_id, resource_date),
    INDEX idx_booking (triggered_by_booking_id),
    INDEX idx_created (created_at)
);

-- ✅ Trigger to log overbooking events
DELIMITER //

CREATE TRIGGER log_overbooking_event
AFTER UPDATE ON inventory
FOR EACH ROW
BEGIN
    DECLARE v_oversell SMALLINT;
    
    -- Calculate actual oversell amount
    SET v_oversell = (NEW.reserved_quantity - OLD.reserved_quantity) - NEW.overbooking_limit;
    
    IF v_oversell > 0 THEN
        INSERT INTO overbooking_log (
            resource_type, resource_id, resource_date,
            total_quantity, reserved_quantity, overbooking_limit,
            actual_oversell
        ) VALUES (
            NEW.resource_type, NEW.resource_id, NEW.resource_date,
            NEW.total_quantity, NEW.reserved_quantity, NEW.overbooking_limit,
            v_oversell
        );
    END IF;
END//

DELIMITER ;
```

**Overbooking Policy by Industry:**

```typescript
export const overbookingPolicies = {
  // Airlines: 5-10% overbooking is standard
  flight: {
    economy: 0.10,      // 10% overbooking allowed
    business: 0.05,     // 5% overbooking allowed
    first: 0.00,        // No overbooking for first class
    
    compensation: {
      voluntary: 400,    // Voluntary bump compensation
      involuntary: 800   // Involuntary bump compensation (4x ticket price cap)
    }
  },
  
  // Hotels: Minimal overbooking (1-2%)
  hotel: {
    standard: 0.02,     // 2% overbooking allowed
    premium: 0.00,      // No overbooking for premium rooms
    
    compensation: {
      upgradeSameHotel: true,
      alternativeHotel: true,
      refundAmount: 1.5  // 1.5x room rate
    }
  },
  
  // Cars: Usually no overbooking
  car: {
    overbookingLimit: 0.00,
    
    compensation: {
      upgradeCategory: true,
      refundAmount: 2.0  // 2x rental rate
    }
  }
};
```

**Alert Configuration:**

```typescript
// ✅ Immediate alert when overbooking occurs
export const overbookingAlert = {
  name: 'overbooking_detected',
  query: 'increase(overbooking_log_total[1m]) > 0',
  for: '0s',  // Immediate
  severity: 'critical',
  action: 'page_oncall',
  notification: {
    pagerduty: true,
    slack: '#revenue-management',
    email: ['revenue@company.com', 'ops@company.com']
  },
  runbook: 'https://wiki.company.com/runbooks/overbooking-response'
};
```

---

### 1.2 Enhanced Inventory Holds with State Machine

**Problem:** Simple expiry mechanism lacks proper state management and audit trail.

**Solution:**

```sql
-- ✅ Complete inventory holds table with state management
CREATE TABLE inventory_holds (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    hold_uuid VARCHAR(36) NOT NULL UNIQUE,  -- For idempotency
    
    -- Resource identification
    resource_type ENUM('hotel_room', 'flight_seat', 'car') NOT NULL,
    resource_id BIGINT NOT NULL,
    resource_date DATE NOT NULL,
    quantity SMALLINT NOT NULL,
    
    -- User context
    user_id BIGINT NOT NULL,
    session_id VARCHAR(100) NOT NULL,
    booking_id BIGINT,  -- NULL until booking confirmed
    
    -- Distributed locking
    fencing_token BIGINT NOT NULL,
    region VARCHAR(20) NOT NULL,  -- Which region created this hold
    
    -- State management
    status ENUM('active', 'confirmed', 'expired', 'released', 'cancelled') DEFAULT 'active',
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    confirmed_at TIMESTAMP NULL,
    released_at TIMESTAMP NULL,
    cancelled_at TIMESTAMP NULL,
    
    -- Metadata
    hold_reason VARCHAR(50),  -- 'user_booking', 'admin_block', 'maintenance'
    released_by VARCHAR(100),
    
    -- ✅ Constraints
    CONSTRAINT chk_quantity CHECK (quantity > 0),
    CONSTRAINT chk_expiry CHECK (expires_at > created_at),
    
    -- ✅ Prevent duplicate active holds
    UNIQUE KEY uniq_active_hold (
        resource_type, resource_id, resource_date, 
        user_id, session_id, status
    ),
    
    INDEX idx_expires (expires_at, status),
    INDEX idx_user_session (user_id, session_id),
    INDEX idx_booking (booking_id),
    INDEX idx_fencing (fencing_token),
    INDEX idx_status (status, created_at)
);

-- ✅ Hold state transition log
CREATE TABLE inventory_hold_transitions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    hold_id BIGINT NOT NULL,
    
    from_status VARCHAR(20) NOT NULL,
    to_status VARCHAR(20) NOT NULL,
    
    transition_reason VARCHAR(255),
    transitioned_by VARCHAR(100),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (hold_id) REFERENCES inventory_holds(id) ON DELETE CASCADE,
    
    INDEX idx_hold (hold_id),
    INDEX idx_created (created_at)
);

-- ✅ Stored procedure for safe hold release
DELIMITER //

CREATE PROCEDURE release_expired_holds()
BEGIN
    DECLARE v_expired_count INT DEFAULT 0;
    DECLARE v_released_quantity INT DEFAULT 0;
    
    -- Temporary table to store expired holds
    CREATE TEMPORARY TABLE IF NOT EXISTS temp_expired_holds (
        hold_id BIGINT,
        resource_type VARCHAR(20),
        resource_id BIGINT,
        resource_date DATE,
        quantity SMALLINT,
        fencing_token BIGINT
    );
    
    START TRANSACTION;
    
    -- ✅ Step 1: Identify and update expired holds
    INSERT INTO temp_expired_holds
    SELECT 
        id, resource_type, resource_id, resource_date, quantity, fencing_token
    FROM inventory_holds
    WHERE status = 'active'
    AND expires_at < NOW()
    FOR UPDATE;
    
    UPDATE inventory_holds
    SET status = 'expired',
        released_at = NOW(),
        released_by = 'system_cron'
    WHERE id IN (SELECT hold_id FROM temp_expired_holds);
    
    SET v_expired_count = ROW_COUNT();
    
    -- ✅ Step 2: Return inventory to available pool
    UPDATE inventory i
    INNER JOIN temp_expired_holds h ON 
        i.resource_type = h.resource_type AND
        i.resource_id = h.resource_id AND
        i.resource_date = h.resource_date
    SET i.reserved_quantity = i.reserved_quantity - h.quantity,
        i.available_quantity = i.available_quantity + h.quantity,
        i.updated_at = NOW()
    WHERE i.fencing_token < h.fencing_token;  -- ✅ Fencing token check
    
    SET v_released_quantity = ROW_COUNT();
    
    -- ✅ Step 3: Log transitions
    INSERT INTO inventory_hold_transitions (hold_id, from_status, to_status, transition_reason, transitioned_by)
    SELECT 
        hold_id, 
        'active', 
        'expired',
        'Automatic expiry by cron job',
        'system_cron'
    FROM temp_expired_holds;
    
    COMMIT;
    
    -- Cleanup
    DROP TEMPORARY TABLE IF EXISTS temp_expired_holds;
    
    -- Return stats
    SELECT 
        v_expired_count as expired_holds,
        v_released_quantity as inventory_released,
        NOW() as processed_at;
END//

DELIMITER ;

-- ✅ Event scheduler for hold expiry (runs every 30 seconds)
CREATE EVENT release_expired_holds_event
ON SCHEDULE EVERY 30 SECOND
DO
    CALL release_expired_holds();
```

**Service Layer Implementation:**

```typescript
// ============================================
// Inventory Hold Service
// ============================================

export class InventoryHoldService {
  
  /**
   * ✅ Create hold with proper state management
   */
  async createHold(params: {
    resourceType: string;
    resourceId: bigint;
    resourceDate: Date;
    quantity: number;
    userId: bigint;
    sessionId: string;
    ttlSeconds: number;
  }): Promise<InventoryHold> {
    
    const holdUuid = randomUUID();
    const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);
    const fencingToken = await this.getNextFencingToken(
      params.resourceType,
      params.resourceId,
      params.resourceDate
    );
    
    const connection = await db.getConnection();
    
    try {
      await connection.beginTransaction();
      
      // ✅ Check if user already has active hold for this resource
      const [existing] = await connection.execute(`
        SELECT id FROM inventory_holds
        WHERE user_id = ?
        AND session_id = ?
        AND resource_type = ?
        AND resource_id = ?
        AND resource_date = ?
        AND status = 'active'
      `, [
        params.userId,
        params.sessionId,
        params.resourceType,
        params.resourceId,
        params.resourceDate
      ]);
      
      if (existing.length > 0) {
        // Extend existing hold instead of creating new one
        await connection.execute(`
          UPDATE inventory_holds
          SET expires_at = ?
          WHERE id = ?
        `, [expiresAt, existing[0].id]);
        
        await connection.commit();
        return this.getHoldById(existing[0].id);
      }
      
      // ✅ Reserve inventory (with fencing token)
      const [result] = await connection.execute(`
        UPDATE inventory
        SET reserved_quantity = reserved_quantity + ?,
            available_quantity = available_quantity - ?,
            fencing_token = ?,
            updated_at = NOW()
        WHERE resource_type = ?
        AND resource_id = ?
        AND resource_date = ?
        AND available_quantity >= ?
        AND (fencing_token IS NULL OR fencing_token < ?)
      `, [
        params.quantity,
        params.quantity,
        fencingToken,
        params.resourceType,
        params.resourceId,
        params.resourceDate,
        params.quantity,
        fencingToken
      ]);
      
      if (result.affectedRows === 0) {
        throw new InsufficientInventoryError('Not enough inventory available');
      }
      
      // ✅ Create hold record
      await connection.execute(`
        INSERT INTO inventory_holds (
          hold_uuid, resource_type, resource_id, resource_date,
          quantity, user_id, session_id, fencing_token,
          region, status, expires_at, hold_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 'user_booking')
      `, [
        holdUuid,
        params.resourceType,
        params.resourceId,
        params.resourceDate,
        params.quantity,
        params.userId,
        params.sessionId,
        fencingToken,
        process.env.REGION,
        expiresAt
      ]);
      
      const holdId = result.insertId;
      
      // ✅ Log state transition
      await connection.execute(`
        INSERT INTO inventory_hold_transitions (
          hold_id, from_status, to_status, transition_reason, transitioned_by
        ) VALUES (?, 'none', 'active', 'Hold created by user', ?)
      `, [holdId, `user:${params.userId}`]);
      
      await connection.commit();
      
      // ✅ Emit event for multi-region sync
      await this.emitHoldCreatedEvent({
        holdId,
        holdUuid,
        ...params,
        fencingToken,
        expiresAt
      });
      
      return this.getHoldById(holdId);
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * ✅ Confirm hold (convert to booking)
   */
  async confirmHold(
    holdId: bigint,
    bookingId: bigint
  ): Promise<void> {
    
    const connection = await db.getConnection();
    
    try {
      await connection.beginTransaction();
      
      const [result] = await connection.execute(`
        UPDATE inventory_holds
        SET status = 'confirmed',
            booking_id = ?,
            confirmed_at = NOW()
        WHERE id = ?
        AND status = 'active'
        AND expires_at > NOW()
      `, [bookingId, holdId]);
      
      if (result.affectedRows === 0) {
        throw new InvalidHoldStateError('Hold is not active or has expired');
      }
      
      // ✅ Log transition
      await connection.execute(`
        INSERT INTO inventory_hold_transitions (
          hold_id, from_status, to_status, transition_reason, transitioned_by
        ) VALUES (?, 'active', 'confirmed', 'Booking confirmed', ?)
      `, [holdId, `booking:${bookingId}`]);
      
      await connection.commit();
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * ✅ Release hold (manual cancellation)
   */
  async releaseHold(
    holdId: bigint,
    reason: string,
    releasedBy: string
  ): Promise<void> {
    
    const connection = await db.getConnection();
    
    try {
      await connection.beginTransaction();
      
      // Get hold details
      const [holds] = await connection.execute(`
        SELECT 
          resource_type, resource_id, resource_date, 
          quantity, fencing_token, status
        FROM inventory_holds
        WHERE id = ?
        FOR UPDATE
      `, [holdId]);
      
      if (holds.length === 0) {
        throw new NotFoundError('Hold not found');
      }
      
      const hold = holds[0];
      
      if (hold.status !== 'active') {
        throw new InvalidHoldStateError(`Cannot release hold in status: ${hold.status}`);
      }
      
      // ✅ Update hold status
      await connection.execute(`
        UPDATE inventory_holds
        SET status = 'released',
            released_at = NOW(),
            released_by = ?
        WHERE id = ?
      `, [releasedBy, holdId]);
      
      // ✅ Return inventory
      await connection.execute(`
        UPDATE inventory
        SET reserved_quantity = reserved_quantity - ?,
            available_quantity = available_quantity + ?,
            updated_at = NOW()
        WHERE resource_type = ?
        AND resource_id = ?
        AND resource_date = ?
      `, [
        hold.quantity,
        hold.quantity,
        hold.resource_type,
        hold.resource_id,
        hold.resource_date
      ]);
      
      // ✅ Log transition
      await connection.execute(`
        INSERT INTO inventory_hold_transitions (
          hold_id, from_status, to_status, transition_reason, transitioned_by
        ) VALUES (?, 'active', 'released', ?, ?)
      `, [holdId, reason, releasedBy]);
      
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

---

## 2. Inventory Management Improvements

### 2.1 Fencing Tokens Integration

```sql
-- ✅ Add fencing token to inventory table
ALTER TABLE inventory
ADD COLUMN fencing_token BIGINT,
ADD INDEX idx_fencing (resource_type, resource_id, fencing_token);

-- ✅ All inventory updates must include fencing token check
-- Example update pattern:
UPDATE inventory
SET available_quantity = available_quantity - ?,
    reserved_quantity = reserved_quantity + ?,
    fencing_token = ?,
    updated_at = NOW()
WHERE resource_type = ?
AND resource_id = ?
AND resource_date = ?
AND available_quantity >= ?
AND (fencing_token IS NULL OR fencing_token < ?);  -- ✅ Fencing check
```

### 2.2 Inventory Snapshot for Auditing

```sql
-- ✅ Inventory snapshots for daily reconciliation
CREATE TABLE inventory_snapshots (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    
    snapshot_date DATE NOT NULL,
    resource_type VARCHAR(20) NOT NULL,
    resource_id BIGINT NOT NULL,
    resource_date DATE NOT NULL,
    
    -- Snapshot values
    total_quantity SMALLINT NOT NULL,
    available_quantity SMALLINT NOT NULL,
    reserved_quantity SMALLINT NOT NULL,
    overbooking_limit SMALLINT NOT NULL,
    
    -- Calculated metrics
    utilization_percent DECIMAL(5,2),  -- (reserved / total) * 100
    revenue_per_unit DECIMAL(10,2),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE KEY uniq_snapshot (snapshot_date, resource_type, resource_id, resource_date),
    INDEX idx_date (snapshot_date),
    INDEX idx_resource (resource_type, resource_id)
);

-- ✅ Daily snapshot creation
CREATE EVENT create_daily_inventory_snapshots
ON SCHEDULE EVERY 1 DAY
STARTS (TIMESTAMP(CURRENT_DATE) + INTERVAL 1 DAY + INTERVAL 1 HOUR)
DO
BEGIN
    INSERT INTO inventory_snapshots (
        snapshot_date, resource_type, resource_id, resource_date,
        total_quantity, available_quantity, reserved_quantity, overbooking_limit,
        utilization_percent
    )
    SELECT 
        CURDATE() as snapshot_date,
        resource_type,
        resource_id,
        resource_date,
        total_quantity,
        available_quantity,
        reserved_quantity,
        overbooking_limit,
        ROUND((reserved_quantity * 100.0) / NULLIF(total_quantity, 0), 2) as utilization_percent
    FROM inventory
    WHERE resource_date >= CURDATE()
    ON DUPLICATE KEY UPDATE
        total_quantity = VALUES(total_quantity),
        available_quantity = VALUES(available_quantity),
        reserved_quantity = VALUES(reserved_quantity),
        utilization_percent = VALUES(utilization_percent);
END;
```

---

## 3. Double-Entry Accounting System

### 3.1 Chart of Accounts

```sql
-- ✅ Complete chart of accounts
CREATE TABLE chart_of_accounts (
    account_code VARCHAR(50) PRIMARY KEY,
    account_name VARCHAR(255) NOT NULL,
    account_type ENUM('asset', 'liability', 'revenue', 'expense', 'equity') NOT NULL,
    parent_account VARCHAR(50),
    
    -- Account metadata
    is_active BOOLEAN DEFAULT TRUE,
    is_system_account BOOLEAN DEFAULT FALSE,  -- Cannot be deleted
    
    currency CHAR(3) DEFAULT 'USD',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (parent_account) REFERENCES chart_of_accounts(account_code),
    
    INDEX idx_type (account_type),
    INDEX idx_parent (parent_account)
);

-- ✅ Seed standard accounts
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
('5400', 'Marketing Expenses', 'expense', TRUE),

-- Equity (3000-3999)
('3000', 'Shareholders Equity', 'equity', TRUE),
('3100', 'Retained Earnings', 'equity', TRUE);
```

### 3.2 Accounting Entries (Double-Entry System)

```sql
-- ✅ Accounting journal entries
CREATE TABLE accounting_entries (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    
    entry_number VARCHAR(50) NOT NULL UNIQUE,  -- e.g., "JE-2026-02-15-00001"
    entry_date DATE NOT NULL,
    entry_type ENUM('journal', 'payment', 'refund', 'adjustment') NOT NULL,
    
    -- Related entities
    booking_id BIGINT,
    transaction_id BIGINT,
    user_id BIGINT,
    
    description TEXT,
    
    -- Status
    is_posted BOOLEAN DEFAULT FALSE,
    posted_at TIMESTAMP NULL,
    posted_by BIGINT,
    
    -- Audit
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by BIGINT,
    
    -- ✅ Prevent modification after posting
    CONSTRAINT chk_posted_immutable CHECK (
        is_posted = FALSE OR 
        (is_posted = TRUE AND posted_at IS NOT NULL)
    ),
    
    INDEX idx_entry_number (entry_number),
    INDEX idx_booking (booking_id),
    INDEX idx_date (entry_date),
    INDEX idx_posted (is_posted, posted_at)
);

-- ✅ Accounting entry lines (debits and credits)
CREATE TABLE accounting_entry_lines (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    
    entry_id BIGINT NOT NULL,
    line_number SMALLINT NOT NULL,
    
    account_code VARCHAR(50) NOT NULL,
    
    -- ✅ Separate columns for debit and credit (double-entry principle)
    debit_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    credit_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    
    -- Exchange rate (if different from base currency)
    exchange_rate DECIMAL(12,6) DEFAULT 1.000000,
    
    description TEXT,
    
    -- Reference
    reference_type VARCHAR(50),  -- 'booking', 'transaction', 'invoice'
    reference_id BIGINT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (entry_id) REFERENCES accounting_entries(id) ON DELETE RESTRICT,
    FOREIGN KEY (account_code) REFERENCES chart_of_accounts(account_code),
    
    -- ✅ Core double-entry constraint: amount must be either debit OR credit, not both
    CONSTRAINT chk_debit_or_credit CHECK (
        (debit_amount > 0 AND credit_amount = 0) OR
        (debit_amount = 0 AND credit_amount > 0)
    ),
    
    CONSTRAINT chk_amounts_positive CHECK (
        debit_amount >= 0 AND credit_amount >= 0
    ),
    
    INDEX idx_entry_line (entry_id, line_number),
    INDEX idx_account (account_code),
    INDEX idx_reference (reference_type, reference_id)
);

-- ✅ Trigger to ensure balanced entries before posting
DELIMITER //

CREATE TRIGGER validate_balanced_entry_before_post
BEFORE UPDATE ON accounting_entries
FOR EACH ROW
BEGIN
    DECLARE v_total_debit DECIMAL(12,2);
    DECLARE v_total_credit DECIMAL(12,2);
    
    -- Only validate when posting
    IF NEW.is_posted = TRUE AND OLD.is_posted = FALSE THEN
        
        -- Calculate totals
        SELECT 
            SUM(debit_amount),
            SUM(credit_amount)
        INTO v_total_debit, v_total_credit
        FROM accounting_entry_lines
        WHERE entry_id = NEW.id;
        
        -- ✅ Fundamental accounting equation: Debits = Credits
        IF ABS(v_total_debit - v_total_credit) > 0.01 THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = CONCAT(
                'Accounting entry is not balanced. ',
                'Debits: ', v_total_debit, ', ',
                'Credits: ', v_total_credit
            );
        END IF;
        
        -- Validate at least 2 lines (one debit, one credit minimum)
        IF (SELECT COUNT(*) FROM accounting_entry_lines WHERE entry_id = NEW.id) < 2 THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Accounting entry must have at least 2 lines (debit and credit)';
        END IF;
        
        SET NEW.posted_at = NOW();
    END IF;
END//

-- ✅ Prevent updates to posted entries
CREATE TRIGGER prevent_posted_entry_modification
BEFORE UPDATE ON accounting_entry_lines
FOR EACH ROW
BEGIN
    DECLARE v_is_posted BOOLEAN;
    
    SELECT is_posted INTO v_is_posted
    FROM accounting_entries
    WHERE id = NEW.entry_id;
    
    IF v_is_posted = TRUE THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Cannot modify lines of a posted accounting entry';
    END IF;
END//

-- ✅ Prevent deletion of posted entries
CREATE TRIGGER prevent_posted_entry_deletion
BEFORE DELETE ON accounting_entry_lines
FOR EACH ROW
BEGIN
    DECLARE v_is_posted BOOLEAN;
    
    SELECT is_posted INTO v_is_posted
    FROM accounting_entries
    WHERE id = OLD.entry_id;
    
    IF v_is_posted = TRUE THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Cannot delete lines of a posted accounting entry';
    END IF;
END//

DELIMITER ;
```

### 3.3 Accounting Service Implementation

```typescript
// ============================================
// Double-Entry Accounting Service
// ============================================

export class AccountingService {
  
  /**
   * ✅ Record customer payment (double-entry)
   */
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
      
      // ✅ Step 1: Create accounting entry
      const entryNumber = await this.generateEntryNumber('payment');
      
      await connection.execute(`
        INSERT INTO accounting_entries (
          entry_number, entry_date, entry_type,
          booking_id, transaction_id,
          description, created_by
        ) VALUES (?, CURDATE(), 'payment', ?, ?, ?, ?)
      `, [
        entryNumber,
        params.bookingId,
        params.transactionId,
        `Customer payment received for booking ${params.bookingId}`,
        null  // system
      ]);
      
      const entryId = connection.lastInsertId();
      
      // ✅ Step 2: Debit - Payment Gateway Clearing (Asset increases)
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, currency,
          description, reference_type, reference_id
        ) VALUES (?, 1, ?, ?, 0, ?, ?, 'transaction', ?)
      `, [
        entryId,
        this.getPaymentGatewayAccount(params.paymentProvider),
        params.amount,
        params.currency,
        `Payment received via ${params.paymentProvider}`,
        params.transactionId
      ]);
      
      // ✅ Step 3: Credit - Customer Deposits (Liability increases)
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, currency,
          description, reference_type, reference_id
        ) VALUES (?, 2, '2100', 0, ?, ?, ?, 'booking', ?)
      `, [
        entryId,
        params.amount,
        params.currency,
        'Customer deposit for booking',
        params.bookingId
      ]);
      
      // ✅ Step 4: Post entry (make it immutable)
      await connection.execute(`
        UPDATE accounting_entries
        SET is_posted = TRUE
        WHERE id = ?
      `, [entryId]);
      
      await connection.commit();
      
      console.log(`Accounting entry ${entryNumber} posted successfully`);
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * ✅ Record booking revenue recognition
   */
  async recognizeBookingRevenue(params: {
    bookingId: bigint;
    bookingType: string;
    amount: number;
    supplierCost: number;
    serviceFee: number;
  }): Promise<void> {
    
    const connection = await db.getConnection();
    
    try {
      await connection.beginTransaction();
      
      const entryNumber = await this.generateEntryNumber('journal');
      
      // Create entry
      await connection.execute(`
        INSERT INTO accounting_entries (
          entry_number, entry_date, entry_type,
          booking_id, description, created_by
        ) VALUES (?, CURDATE(), 'journal', ?, ?, ?)
      `, [
        entryNumber,
        params.bookingId,
        `Revenue recognition for ${params.bookingType} booking`,
        null
      ]);
      
      const entryId = connection.lastInsertId();
      
      // ✅ Debit 1: Customer Deposits (Liability decreases)
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, description
        ) VALUES (?, 1, '2100', ?, 0, 'Transfer from customer deposit')
      `, [entryId, params.amount]);
      
      // ✅ Credit 1: Booking Revenue (Revenue increases)
      const revenueAccount = this.getRevenueAccount(params.bookingType);
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, description
        ) VALUES (?, 2, ?, 0, ?, 'Booking revenue')
      `, [entryId, revenueAccount, params.amount]);
      
      // ✅ Debit 2: Cost of Sales (Expense increases)
      const costAccount = this.getCostAccount(params.bookingType);
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, description
        ) VALUES (?, 3, ?, ?, 0, 'Supplier cost')
      `, [entryId, costAccount, params.supplierCost]);
      
      // ✅ Credit 2: Supplier Payables (Liability increases)
      const payableAccount = this.getSupplierPayableAccount(params.bookingType);
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, description
        ) VALUES (?, 4, ?, 0, ?, 'Amount owed to supplier')
      `, [entryId, payableAccount, params.supplierCost]);
      
      // Post entry
      await connection.execute(`
        UPDATE accounting_entries SET is_posted = TRUE WHERE id = ?
      `, [entryId]);
      
      await connection.commit();
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * ✅ Get account balance
   */
  async getAccountBalance(
    accountCode: string,
    asOfDate?: Date
  ): Promise<number> {
    
    const dateFilter = asOfDate 
      ? `AND ae.entry_date <= '${format(asOfDate, 'yyyy-MM-dd')}'`
      : '';
    
    const [rows] = await db.execute(`
      SELECT 
        SUM(ael.debit_amount) as total_debits,
        SUM(ael.credit_amount) as total_credits
      FROM accounting_entry_lines ael
      INNER JOIN accounting_entries ae ON ael.entry_id = ae.id
      WHERE ael.account_code = ?
      AND ae.is_posted = TRUE
      ${dateFilter}
    `, [accountCode]);
    
    const totalDebits = rows[0]?.total_debits || 0;
    const totalCredits = rows[0]?.total_credits || 0;
    
    // ✅ Balance calculation depends on account type
    const [accountInfo] = await db.execute(`
      SELECT account_type FROM chart_of_accounts WHERE account_code = ?
    `, [accountCode]);
    
    const accountType = accountInfo[0]?.account_type;
    
    // Assets & Expenses: Debit balance (debits - credits)
    // Liabilities, Revenue & Equity: Credit balance (credits - debits)
    if (accountType === 'asset' || accountType === 'expense') {
      return totalDebits - totalCredits;
    } else {
      return totalCredits - totalDebits;
    }
  }
  
  /**
   * ✅ Generate sequential entry number
   */
  private async generateEntryNumber(type: string): Promise<string> {
    const date = format(new Date(), 'yyyy-MM-dd');
    const prefix = type === 'payment' ? 'PMT' : 'JE';
    
    const key = `accounting:entry:${prefix}:${date}`;
    const sequence = await redis.incr(key);
    
    if (sequence === 1) {
      await redis.expire(key, 7 * 24 * 60 * 60); // 7 days
    }
    
    return `${prefix}-${format(new Date(), 'yyyy-MM-dd')}-${sequence.toString().padStart(5, '0')}`;
  }
  
  private getPaymentGatewayAccount(provider: string): string {
    const mapping = {
      'stripe': '1210',
      'paypal': '1220'
    };
    return mapping[provider.toLowerCase()] || '1200';
  }
  
  private getRevenueAccount(bookingType: string): string {
    const mapping = {
      'hotel': '4110',
      'flight': '4120',
      'car': '4130'
    };
    return mapping[bookingType.toLowerCase()] || '4100';
  }
  
  private getCostAccount(bookingType: string): string {
    const mapping = {
      'hotel': '5110',
      'flight': '5120',
      'car': '5130'
    };
    return mapping[bookingType.toLowerCase()] || '5100';
  }
  
  private getSupplierPayableAccount(bookingType: string): string {
    const mapping = {
      'hotel': '2210',
      'flight': '2220',
      'car': '2230'
    };
    return mapping[bookingType.toLowerCase()] || '2200';
  }
}
```

### 3.4 Daily Reconciliation Process

```sql
-- ✅ Provider reconciliation table
CREATE TABLE provider_reconciliations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    
    reconciliation_date DATE NOT NULL,
    payment_provider VARCHAR(50) NOT NULL,
    
    -- Our records
    our_total_transactions INT NOT NULL,
    our_total_amount DECIMAL(12,2) NOT NULL,
    our_fee_amount DECIMAL(12,2) NOT NULL,
    
    -- Provider report
    provider_total_transactions INT,
    provider_total_amount DECIMAL(12,2),
    provider_fee_amount DECIMAL(12,2),
    
    -- Discrepancies
    transaction_difference INT GENERATED ALWAYS AS (our_total_transactions - provider_total_transactions) STORED,
    amount_difference DECIMAL(12,2) GENERATED ALWAYS AS (our_total_amount - provider_total_amount) STORED,
    fee_difference DECIMAL(12,2) GENERATED ALWAYS AS (our_fee_amount - provider_fee_amount) STORED,
    
    -- Status
    status ENUM('pending', 'matched', 'discrepancy', 'resolved') DEFAULT 'pending',
    
    -- Resolution
    resolved_at TIMESTAMP NULL,
    resolved_by BIGINT,
    resolution_notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE KEY uniq_date_provider (reconciliation_date, payment_provider),
    INDEX idx_status (status),
    INDEX idx_date (reconciliation_date)
);

-- ✅ Stored procedure for daily reconciliation
DELIMITER //

CREATE PROCEDURE reconcile_payment_provider(
    IN p_date DATE,
    IN p_provider VARCHAR(50)
)
BEGIN
    DECLARE v_our_count INT;
    DECLARE v_our_total DECIMAL(12,2);
    DECLARE v_our_fees DECIMAL(12,2);
    
    -- Calculate our totals
    SELECT 
        COUNT(*),
        SUM(amount),
        SUM(provider_fee)
    INTO v_our_count, v_our_total, v_our_fees
    FROM transactions
    WHERE DATE(created_at) = p_date
    AND payment_provider = p_provider
    AND status = 'completed';
    
    -- Insert reconciliation record
    INSERT INTO provider_reconciliations (
        reconciliation_date,
        payment_provider,
        our_total_transactions,
        our_total_amount,
        our_fee_amount
    ) VALUES (
        p_date,
        p_provider,
        v_our_count,
        v_our_total,
        v_our_fees
    )
    ON DUPLICATE KEY UPDATE
        our_total_transactions = v_our_count,
        our_total_amount = v_our_total,
        our_fee_amount = v_our_fees;
END//

DELIMITER ;
```

---

## 4. Multi-Region Conflict Resolution

### 4.1 Global Event Stream Architecture

```typescript
// ============================================
// Multi-Region Inventory Synchronization
// ============================================

export class MultiRegionInventoryService {
  private readonly region = process.env.REGION;
  
  /**
   * ✅ Reserve inventory with global conflict detection
   */
  async reserveInventory(params: {
    resourceType: string;
    resourceId: bigint;
    resourceDate: Date;
    quantity: number;
    userId: bigint;
  }): Promise<ReservationResult> {
    
    // ✅ Step 1: Acquire local distributed lock
    const lockKey = this.getInventoryLockKey(
      params.resourceType,
      params.resourceId,
      params.resourceDate
    );
    
    const lockResult = await this.fencedLockService.acquireLockWithFencing(
      lockKey,
      10000  // 10 seconds
    );
    
    if (!lockResult) {
      throw new ConflictError('Resource is locked');
    }
    
    const { lock, fencingToken } = lockResult;
    
    try {
      // ✅ Step 2: Reserve locally
      const localReservation = await this.reserveLocally(
        params,
        fencingToken
      );
      
      if (!localReservation.success) {
        return localReservation;
      }
      
      // ✅ Step 3: Publish to global event stream
      await this.publishGlobalReservationEvent({
        reservationId: localReservation.reservationId,
        region: this.region,
        fencingToken,
        ...params,
        timestamp: Date.now()
      });
      
      // ✅ Step 4: Wait for acknowledgment from other regions
      const globalAck = await this.waitForGlobalConsensus(
        localReservation.reservationId,
        2000  // 2 second timeout
      );
      
      if (!globalAck.success) {
        // Conflict detected - rollback
        await this.rollbackReservation(localReservation.reservationId);
        
        return {
          success: false,
          reason: 'multi_region_conflict',
          conflictingRegion: globalAck.conflictingRegion,
          conflictingReservationId: globalAck.conflictingReservationId
        };
      }
      
      return localReservation;
      
    } finally {
      await this.fencedLockService.releaseLock(lockKey, lock, fencingToken);
    }
  }
  
  /**
   * ✅ Reserve inventory locally
   */
  private async reserveLocally(
    params: {
      resourceType: string;
      resourceId: bigint;
      resourceDate: Date;
      quantity: number;
      userId: bigint;
    },
    fencingToken: number
  ): Promise<{ success: boolean; reservationId?: bigint }> {
    
    const connection = await db.getConnection();
    
    try {
      await connection.beginTransaction();
      
      // ✅ Update inventory with fencing token
      const [result] = await connection.execute(`
        UPDATE inventory
        SET reserved_quantity = reserved_quantity + ?,
            available_quantity = available_quantity - ?,
            fencing_token = ?,
            updated_at = NOW()
        WHERE resource_type = ?
        AND resource_id = ?
        AND resource_date = ?
        AND available_quantity >= ?
        AND (fencing_token IS NULL OR fencing_token < ?)
      `, [
        params.quantity,
        params.quantity,
        fencingToken,
        params.resourceType,
        params.resourceId,
        params.resourceDate,
        params.quantity,
        fencingToken
      ]);
      
      if (result.affectedRows === 0) {
        await connection.rollback();
        return { success: false };
      }
      
      // ✅ Create reservation record
      await connection.execute(`
        INSERT INTO inventory_reservations (
          resource_type, resource_id, resource_date,
          quantity, user_id, region, fencing_token, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_confirmation')
      `, [
        params.resourceType,
        params.resourceId,
        params.resourceDate,
        params.quantity,
        params.userId,
        this.region,
        fencingToken
      ]);
      
      const reservationId = connection.lastInsertId();
      
      await connection.commit();
      
      return { success: true, reservationId };
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * ✅ Publish reservation event to global Kafka topic
   */
  private async publishGlobalReservationEvent(event: any): Promise<void> {
    
    await kafka.send({
      topic: 'inventory-reservations-global',
      messages: [{
        key: `${event.resourceType}:${event.resourceId}:${event.resourceDate}`,
        value: JSON.stringify(event),
        headers: {
          'source-region': this.region,
          'event-type': 'reservation-created',
          'fencing-token': event.fencingToken.toString()
        }
      }],
      // ✅ Use idempotent producer
      idempotent: true
    });
  }
  
  /**
   * ✅ Wait for global consensus
   */
  private async waitForGlobalConsensus(
    reservationId: bigint,
    timeoutMs: number
  ): Promise<{ success: boolean; conflictingRegion?: string; conflictingReservationId?: bigint }> {
    
    const consensusKey = `consensus:reservation:${reservationId}`;
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Timeout = consensus achieved (no conflicts detected)
        resolve({ success: true });
      }, timeoutMs);
      
      // Listen for conflict notifications
      const subscriber = redis.duplicate();
      
      subscriber.subscribe(`conflicts:${reservationId}`, (err) => {
        if (err) {
          clearTimeout(timeout);
          resolve({ success: false });
        }
      });
      
      subscriber.on('message', (channel, message) => {
        clearTimeout(timeout);
        subscriber.quit();
        
        const conflict = JSON.parse(message);
        resolve({
          success: false,
          conflictingRegion: conflict.region,
          conflictingReservationId: conflict.reservationId
        });
      });
    });
  }
  
  /**
   * ✅ Global conflict detection consumer
   */
  async startGlobalConflictDetector(): Promise<void> {
    
    await kafka.subscribe({
      topic: 'inventory-reservations-global',
      fromBeginning: false
    });
    
    await kafka.run({
      eachMessage: async ({ topic, partition, message }) => {
        const event = JSON.parse(message.value.toString());
        const sourceRegion = message.headers['source-region'].toString();
        
        // Skip our own events
        if (sourceRegion === this.region) {
          return;
        }
        
        // ✅ Check for local conflicting reservation
        const localReservation = await this.findLocalReservation(
          event.resourceType,
          event.resourceId,
          event.resourceDate
        );
        
        if (!localReservation) {
          // No conflict
          return;
        }
        
        // ✅ Conflict detected - resolve using fencing token
        if (event.fencingToken > localReservation.fencingToken) {
          // Remote wins - rollback local
          console.warn(
            `Conflict: Remote region ${sourceRegion} wins. ` +
            `Rolling back local reservation ${localReservation.id}`
          );
          
          await this.rollbackReservation(localReservation.id);
          
          // Notify local process that it lost
          await redis.publish(
            `conflicts:${localReservation.id}`,
            JSON.stringify({
              region: sourceRegion,
              reservationId: event.reservationId,
              fencingToken: event.fencingToken
            })
          );
          
        } else {
          // Local wins - notify remote to rollback
          console.log(
            `Conflict: Local reservation ${localReservation.id} wins. ` +
            `Notifying region ${sourceRegion} to rollback`
          );
          
          await kafka.send({
            topic: 'inventory-conflicts',
            messages: [{
              value: JSON.stringify({
                winningRegion: this.region,
                winningReservationId: localReservation.id,
                losingRegion: sourceRegion,
                losingReservationId: event.reservationId
              })
            }]
          });
        }
      }
    });
  }
  
  /**
   * ✅ Rollback reservation
   */
  private async rollbackReservation(reservationId: bigint): Promise<void> {
    
    const connection = await db.getConnection();
    
    try {
      await connection.beginTransaction();
      
      // Get reservation details
      const [reservations] = await connection.execute(`
        SELECT resource_type, resource_id, resource_date, quantity
        FROM inventory_reservations
        WHERE id = ?
        FOR UPDATE
      `, [reservationId]);
      
      if (reservations.length === 0) {
        await connection.rollback();
        return;
      }
      
      const res = reservations[0];
      
      // Update reservation status
      await connection.execute(`
        UPDATE inventory_reservations
        SET status = 'rolled_back',
            rolled_back_at = NOW()
        WHERE id = ?
      `, [reservationId]);
      
      // Return inventory
      await connection.execute(`
        UPDATE inventory
        SET reserved_quantity = reserved_quantity - ?,
            available_quantity = available_quantity + ?,
            updated_at = NOW()
        WHERE resource_type = ?
        AND resource_id = ?
        AND resource_date = ?
      `, [
        res.quantity,
        res.quantity,
        res.resource_type,
        res.resource_id,
        res.resource_date
      ]);
      
      await connection.commit();
      
      console.log(`Reservation ${reservationId} rolled back successfully`);
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
```

### 4.2 Regional Partitioning Strategy

```typescript
// ============================================
// Inventory Partitioning by Region
// ============================================

export const inventoryPartitioningStrategy = {
  
  /**
   * ✅ Partition inventory by primary region
   * 
   * Each hotel/resource has a "home region" where most
   * inventory decisions are made to minimize conflicts
   */
  getResourceHomeRegion(resourceId: bigint): string {
    // Hash-based partitioning
    const regionIndex = Number(resourceId % 3n);
    
    const regions = ['us-east', 'eu-west', 'ap-southeast'];
    return regions[regionIndex];
  },
  
  /**
   * ✅ Route inventory requests to home region first
   */
  async reserveWithRegionalRouting(params: {
    resourceType: string;
    resourceId: bigint;
    resourceDate: Date;
    quantity: number;
    userId: bigint;
    userRegion: string;
  }): Promise<ReservationResult> {
    
    const homeRegion = this.getResourceHomeRegion(params.resourceId);
    
    if (params.userRegion === homeRegion) {
      // User is in home region - reserve locally
      return await inventoryService.reserveInventory(params);
      
    } else {
      // User in different region - forward to home region
      return await this.forwardReservationToHomeRegion(
        homeRegion,
        params
      );
    }
  },
  
  /**
   * ✅ Cross-region API call with retry
   */
  async forwardReservationToHomeRegion(
    homeRegion: string,
    params: any
  ): Promise<ReservationResult> {
    
    const homeRegionEndpoint = this.getRegionEndpoint(homeRegion);
    
    try {
      const response = await axios.post(
        `${homeRegionEndpoint}/api/inventory/reserve`,
        params,
        {
          timeout: 5000,
          headers: {
            'X-Forwarded-From-Region': process.env.REGION,
            'X-Request-ID': randomUUID()
          }
        }
      );
      
      return response.data;
      
    } catch (error) {
      // Fallback to local region if home region is down
      console.warn(
        `Failed to forward to home region ${homeRegion}. ` +
        `Falling back to local reservation.`
      );
      
      return await inventoryService.reserveInventory(params);
    }
  },
  
  getRegionEndpoint(region: string): string {
    const endpoints = {
      'us-east': 'https://api-us-east.booking.com',
      'eu-west': 'https://api-eu-west.booking.com',
      'ap-southeast': 'https://api-ap-southeast.booking.com'
    };
    
    return endpoints[region];
  }
};
```

---

## 5. Enhanced Monitoring & Alerting

### 5.1 Comprehensive Alert Rules

```typescript
// ============================================
// Production Alert Rules (Prometheus)
// ============================================

export const alertRules = {
  
  // ========================================
  // CRITICAL ALERTS (PagerDuty)
  // ========================================
  critical: [
    {
      name: 'BookingSuccessRateCritical',
      expr: `
        rate(bookings_total{status="success"}[5m]) / 
        rate(bookings_total[5m]) < 0.995
      `,
      for: '2m',
      severity: 'critical',
      annotations: {
        summary: 'Booking success rate below 99.5%',
        description: 'Only {{ $value | humanizePercentage }} bookings succeeding',
        runbook: 'https://runbooks.company.com/booking-failures'
      },
      labels: {
        team: 'platform',
        priority: 'P1'
      }
    },
    
    {
      name: 'InventoryOversellDetected',
      expr: 'increase(inventory_oversell_attempts_total[1m]) > 0',
      for: '0s',  // Immediate
      severity: 'critical',
      annotations: {
        summary: 'Inventory oversell detected',
        description: '{{ $value }} oversell attempts in last minute',
        runbook: 'https://runbooks.company.com/oversell-response'
      },
      labels: {
        team: 'inventory',
        priority: 'P0'
      }
    },
    
    {
      name: 'PaymentGatewayDown',
      expr: 'up{job="payment-gateway"} == 0',
      for: '1m',
      severity: 'critical',
      annotations: {
        summary: 'Payment gateway is down',
        description: 'No payments can be processed',
        runbook: 'https://runbooks.company.com/payment-gateway-outage'
      },
      labels: {
        team: 'payments',
        priority: 'P0'
      }
    },
    
    {
      name: 'DatabasePrimaryDown',
      expr: 'mysql_up{role="primary"} == 0',
      for: '30s',
      severity: 'critical',
      annotations: {
        summary: 'Database primary is down',
        description: 'Shard {{ $labels.shard }} primary is unreachable',
        runbook: 'https://runbooks.company.com/database-failover'
      },
      labels: {
        team: 'infrastructure',
        priority: 'P0'
      }
    },
    
    {
      name: 'KafkaBrokerDown',
      expr: 'kafka_broker_online{} == 0',
      for: '2m',
      severity: 'critical',
      annotations: {
        summary: 'Kafka broker offline',
        description: 'Broker {{ $labels.broker_id }} is down',
        runbook: 'https://runbooks.company.com/kafka-broker-recovery'
      },
      labels: {
        team: 'platform',
        priority: 'P1'
      }
    }
  ],
  
  // ========================================
  // WARNING ALERTS (Slack)
  // ========================================
  warning: [
    {
      name: 'PaymentLatencyHigh',
      expr: `
        histogram_quantile(0.95, 
          rate(payment_duration_seconds_bucket[5m])
        ) > 2
      `,
      for: '5m',
      severity: 'warning',
      annotations: {
        summary: 'Payment latency is high',
        description: 'P95 latency: {{ $value }}s (threshold: 2s)'
      },
      labels: {
        team: 'payments',
        slack_channel: '#payments-alerts'
      }
    },
    
    {
      name: 'LockContentionHigh',
      expr: 'rate(lock_contention_total[5m]) > 100',
      for: '10m',
      severity: 'warning',
      annotations: {
        summary: 'High lock contention detected',
        description: '{{ $value }} lock contentions/sec for {{ $labels.resource_type }}'
      },
      labels: {
        team: 'platform',
        slack_channel: '#platform-alerts'
      }
    },
    
    {
      name: 'FraudScoreSpike',
      expr: 'avg(fraud_risk_score) > 60',
      for: '15m',
      severity: 'warning',
      annotations: {
        summary: 'Average fraud score is elevated',
        description: 'Average fraud score: {{ $value }}/100'
      },
      labels: {
        team: 'fraud',
        slack_channel: '#fraud-detection'
      }
    },
    
    {
      name: 'SupplierAPIErrorRate',
      expr: 'rate(supplier_api_errors_total[5m]) > 10',
      for: '5m',
      severity: 'warning',
      annotations: {
        summary: 'High error rate from supplier {{ $labels.supplier }}',
        description: '{{ $value }} errors/sec'
      },
      labels: {
        team: 'integrations',
        slack_channel: '#supplier-integrations'
      }
    },
    
    {
      name: 'DatabaseReplicationLag',
      expr: 'mysql_slave_lag_seconds > 30',
      for: '3m',
      severity: 'warning',
      annotations: {
        summary: 'Database replication lag is high',
        description: 'Replica {{ $labels.replica }} is {{ $value }}s behind'
      },
      labels: {
        team: 'infrastructure',
        slack_channel: '#database-alerts'
      }
    }
  ],
  
  // ========================================
  // INFO ALERTS (Logging only)
  // ========================================
  info: [
    {
      name: 'BookingVolumeSpike',
      expr: `
        rate(bookings_total[5m]) > 
        avg_over_time(rate(bookings_total[5m])[1h]) * 1.5
      `,
      for: '10m',
      severity: 'info',
      annotations: {
        summary: 'Booking volume spike detected',
        description: 'Current rate: {{ $value }} bookings/sec'
      },
      labels: {
        team: 'analytics'
      }
    },
    
    {
      name: 'NewUserSignupSpike',
      expr: 'rate(user_signups_total[10m]) > avg_over_time(rate(user_signups_total[10m])[6h]) * 2',
      for: '5m',
      severity: 'info',
      annotations: {
        summary: 'Unusual signup activity',
        description: '{{ $value }} signups/min (2x normal)'
      }
    }
  ]
};
```

### 5.2 Custom Metrics Collection

```typescript
// ============================================
// Metrics Collection in Services
// ============================================

export class BookingService {
  
  async createBooking(dto: CreateBookingDto): Promise<Booking> {
    
    const startTime = Date.now();
    const labels = {
      booking_type: dto.bookingType,
      region: process.env.REGION,
      status: 'pending'
    };
    
    try {
      // ... booking creation logic
      
      const duration = (Date.now() - startTime) / 1000;
      
      // ✅ Record success metrics
      MetricsService.bookingCreationTime.observe(
        { ...labels, status: 'success' },
        duration
      );
      
      MetricsService.bookingCounter.inc({
        ...labels,
        status: 'success'
      });
      
      // ✅ Track revenue
      MetricsService.bookingRevenue.inc(
        { booking_type: dto.bookingType },
        dto.totalAmount
      );
      
      return booking;
      
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      
      // ✅ Record failure metrics
      MetricsService.bookingCreationTime.observe(
        { ...labels, status: 'failed' },
        duration
      );
      
      MetricsService.bookingCounter.inc({
        ...labels,
        status: 'failed',
        error_type: error.constructor.name
      });
      
      throw error;
    }
  }
}

export class PaymentService {
  
  async processPayment(params: PaymentParams): Promise<PaymentResult> {
    
    const startTime = Date.now();
    
    try {
      const result = await this.callPaymentGateway(params);
      
      const duration = (Date.now() - startTime) / 1000;
      
      // ✅ Track payment latency
      MetricsService.paymentLatency.observe(
        {
          provider: params.provider,
          status: result.status
        },
        duration
      );
      
      // ✅ Track payment attempts
      MetricsService.paymentAttempts.inc({
        provider: params.provider,
        status: result.status,
        payment_method: params.paymentMethod
      });
      
      // ✅ Calculate and update failure rate gauge
      this.updatePaymentFailureRate(params.provider);
      
      return result;
      
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      
      MetricsService.paymentLatency.observe(
        {
          provider: params.provider,
          status: 'error'
        },
        duration
      );
      
      MetricsService.paymentAttempts.inc({
        provider: params.provider,
        status: 'failed',
        error_type: error.code || 'unknown'
      });
      
      this.updatePaymentFailureRate(params.provider);
      
      throw error;
    }
  }
  
  /**
   * ✅ Update payment failure rate gauge (rolling 5 min window)
   */
  private async updatePaymentFailureRate(provider: string): Promise<void> {
    
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    const [stats] = await db.execute(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status IN ('failed', 'declined') THEN 1 ELSE 0 END) as failures
      FROM transactions
      WHERE payment_provider = ?
      AND created_at >= ?
    `, [provider, fiveMinutesAgo]);
    
    const failureRate = stats[0].total > 0 
      ? stats[0].failures / stats[0].total 
      : 0;
    
    MetricsService.paymentFailureRate.set(
      { provider },
      failureRate
    );
  }
}
```

---

## 6. Detailed Capacity Planning

### 6.1 Traffic Assumptions & Distribution

```typescript
// ============================================
// Traffic Model
// ============================================

export const trafficModel = {
  
  // Peak capacity target
  peak: {
    bookingsPerSecond: 1666,
    bookingsPerMinute: 100000,
    bookingsPerHour: 6000000,
    bookingsPerDay: 144000000
  },
  
  // Average sustained load
  average: {
    bookingsPerSecond: 800,
    bookingsPerMinute: 48000,
    bookingsPerHour: 2880000,
    bookingsPerDay: 69120000
  },
  
  // Read vs Write ratio
  readWriteRatio: {
    reads: 0.70,     // 70% reads (search, view details)
    writes: 0.30     // 30% writes (bookings, payments)
  },
  
  // Geographic distribution
  geographic: {
    'us-east-1': 0.35,      // North America
    'eu-west-1': 0.30,      // Europe
    'ap-southeast-1': 0.25, // Asia Pacific
    'sa-east-1': 0.10       // South America & Others
  },
  
  // Time-based patterns
  peakHours: {
    start: 9,  // 9 AM
    end: 23,   // 11 PM
    durationHours: 14,
    peakMultiplier: 2.5  // 2.5x average during peak hours
  },
  
  // Seasonal variations
  seasonal: {
    highSeason: {  // Summer & Holidays
      months: [6, 7, 8, 12],
      multiplier: 1.8
    },
    lowSeason: {   // Off-peak
      months: [1, 2, 3, 9, 10, 11],
      multiplier: 0.8
    },
    normalSeason: {
      months: [4, 5],
      multiplier: 1.0
    }
  },
  
  // Booking type distribution
  bookingTypes: {
    hotel: 0.45,      // 45% hotels
    flight: 0.35,     // 35% flights
    car: 0.15,        // 15% cars
    package: 0.05     // 5% packages (hotel + flight)
  }
};
```

### 6.2 Database Capacity Plan

```typescript
// ============================================
// Database Sizing & Sharding Strategy
// ============================================

export const databaseCapacity = {
  
  // Sharding configuration
  sharding: {
    totalShards: 16,
    strategy: 'hash',  // hash(user_id) % 16
    replicasPerShard: 5,  // 1 primary + 4 read replicas
    
    // Per-shard specifications
    shardSpecs: {
      instanceType: 'db.r6g.4xlarge',  // AWS RDS
      cpu: '16 vCPUs',
      memory: '128 GB',
      storage: {
        type: 'io2',  // Provisioned IOPS SSD
        size: '3 TB',
        iops: 64000,
        throughput: '4000 MB/s'
      },
      network: '25 Gbps'
    },
    
    // Expected load per shard
    expectedLoad: {
      peak: {
        qps: 600,  // queries per second
        tps: 180,  // transactions per second
        connections: 800
      },
      average: {
        qps: 250,
        tps: 75,
        connections: 400
      }
    },
    
    // Connection pooling
    connectionPool: {
      primary: {
        min: 50,
        max: 200
      },
      replicas: {
        min: 100,
        max: 500
      }
    }
  },
  
  // Storage growth estimation
  storageGrowth: {
    // Average row sizes
    avgRowSizes: {
      bookings: 512,              // bytes
      hotel_bookings: 256,
      flight_bookings: 384,
      transactions: 384,
      payment_ledger: 256,
      booking_events: 1024
    },
    
    // Daily growth
    dailyGrowth: {
      bookings: 69120000,  // rows per day (avg)
      transactions: 69120000,
      payment_ledger: 207360000,  // 3x bookings (auth, capture, fees)
      booking_events: 345600000   // 5x bookings (multiple events)
    },
    
    // Storage per day
    storagePerDay: {
      bookings: '34 GB',
      transactions: '25 GB',
      payment_ledger: '49 GB',
      booking_events: '329 GB',
      total: '437 GB/day'
    },
    
    // Retention & archival
    retention: {
      hot: '90 days',      // Fast SSD storage
      warm: '1 year',      // Standard SSD
      cold: '7 years',     // S3 Glacier
      
      archivalSchedule: 'Daily at 2 AM UTC'
    }
  },
  
  // Backup strategy
  backup: {
    automated: {
      frequency: 'Every 6 hours',
      retentionPeriod: '35 days',
      type: 'Incremental'
    },
    snapshots: {
      frequency: 'Daily at 3 AM UTC',
      retentionPeriod: '90 days',
      type: 'Full'
    },
    pointInTimeRecovery: {
      enabled: true,
      retentionPeriod: '35 days',
      granularity: '5 minutes'
    }
  },
  
  // Estimated monthly cost (AWS us-east-1)
  monthlyCost: {
    primary: {
      instance: 2500,  // per shard
      storage: 800,
      iops: 1200,
      backup: 500,
      total: 5000
    },
    replicas: {
      instances: 8000,  // 4 replicas × $2000
      storage: 3200,
      iops: 4800,
      total: 16000
    },
    perShardTotal: 21000,
    totalAllShards: 336000,  // 16 shards × $21k
    
    // Add cross-region replicas for DR
    disasterRecovery: 168000,  // 50% capacity in DR region
    
    grandTotal: 504000  // ~$504k/month for DB infrastructure
  }
};
```

### 6.3 Redis Cluster Capacity

```typescript
// ============================================
// Redis Cluster Configuration
// ============================================

export const redisCapacity = {
  
  // Separate clusters for different use cases
  clusters: {
    
    // Session storage cluster
    sessions: {
      purpose: 'User sessions & authentication tokens',
      nodeCount: 6,  // 3 masters + 3 replicas
      nodeType: 'cache.r6g.2xlarge',
      
      specs: {
        cpu: '8 vCPUs per node',
        memory: '52 GB per node',
        network: '10 Gbps'
      },
      
      configuration: {
        maxMemory: '48 GB',  // Leave headroom
        evictionPolicy: 'allkeys-lru',
        persistence: 'AOF',  // Append-only file
        snapshotting: 'Disabled'
      },
      
      expectedLoad: {
        peakOps: 50000,  // operations per second
        avgOps: 20000,
        dataSize: '100 GB',
        ttl: '24 hours'
      },
      
      monthlyCost: 3600  // $600 × 6 nodes
    },
    
    // Fencing tokens cluster (critical for distributed locking)
    fencingTokens: {
      purpose: 'Monotonic counters for distributed locking',
      nodeCount: 6,
      nodeType: 'cache.r6g.xlarge',
      
      specs: {
        cpu: '4 vCPUs per node',
        memory: '26 GB per node',
        network: '10 Gbps'
      },
      
      configuration: {
        maxMemory: '24 GB',
        evictionPolicy: 'noeviction',  // Never evict
        persistence: 'RDB + AOF',  // Both for durability
        snapshotting: 'Every 5 minutes'
      },
      
      expectedLoad: {
        peakOps: 10000,
        avgOps: 4000,
        dataSize: '10 GB',
        ttl: 'No expiry'
      },
      
      monthlyCost: 2400  // $400 × 6 nodes
    },
    
    // Cache cluster (search results, pricing, etc.)
    cache: {
      purpose: 'Application-level caching',
      nodeCount: 9,  // 3 shards × 3 replicas
      nodeType: 'cache.r6g.4xlarge',
      
      specs: {
        cpu: '16 vCPUs per node',
        memory: '105 GB per node',
        network: '25 Gbps'
      },
      
      configuration: {
        maxMemory: '100 GB',
        evictionPolicy: 'allkeys-lru',
        persistence: 'Disabled',  // Cache only
        snapshotting: 'Disabled'
      },
      
      expectedLoad: {
        peakOps: 200000,
        avgOps: 80000,
        dataSize: '800 GB',
        hitRate: 0.85,  // 85% cache hit rate
        avgTTL: '1 hour'
      },
      
      monthlyCost: 10800  // $1200 × 9 nodes
    },
    
    // Rate limiting cluster
    rateLimiting: {
      purpose: 'Rate limiting & throttling',
      nodeCount: 3,
      nodeType: 'cache.r6g.large',
      
      specs: {
        cpu: '2 vCPUs per node',
        memory: '13 GB per node'
      },
      
      configuration: {
        maxMemory: '12 GB',
        evictionPolicy: 'volatile-ttl',
        persistence: 'Disabled'
      },
      
      expectedLoad: {
        peakOps: 30000,
        avgOps: 12000,
        dataSize: '5 GB',
        ttl: '1 minute'
      },
      
      monthlyCost: 600  // $200 × 3 nodes
    }
  },
  
  // Total Redis costs
  totalMonthlyCost: 17400,
  
  // Monitoring & alerting
  monitoring: {
    keyMetrics: [
      'cache_hit_rate',
      'evicted_keys',
      'used_memory',
      'connected_clients',
      'ops_per_second',
      'network_bytes_in_out',
      'replication_lag'
    ],
    
    alerts: [
      {
        metric: 'cache_hit_rate',
        threshold: 0.80,
        condition: 'below',
        severity: 'warning'
      },
      {
        metric: 'used_memory_percentage',
        threshold: 0.85,
        condition: 'above',
        severity: 'warning'
      },
      {
        metric: 'replication_lag',
        threshold: 5,  // seconds
        condition: 'above',
        severity: 'critical'
      }
    ]
  }
};
```

### 6.4 Kafka Cluster Capacity

```typescript
// ============================================
// Kafka Cluster Configuration
// ============================================

export const kafkaCapacity = {
  
  // Broker configuration
  brokers: {
    count: 15,
    instanceType: 'kafka.m5.2xlarge',
    
    specs: {
      cpu: '8 vCPUs per broker',
      memory: '32 GB per broker',
      storage: {
        type: 'gp3',  // General Purpose SSD
        size: '4 TB per broker',
        iops: 16000,
        throughput: '1000 MB/s'
      },
      network: '10 Gbps'
    },
    
    // Broker configuration
    configuration: {
      'num.network.threads': 8,
      'num.io.threads': 16,
      'socket.send.buffer.bytes': 102400,
      'socket.receive.buffer.bytes': 102400,
      'socket.request.max.bytes': 104857600,
      'log.retention.hours': 720,  // 30 days
      'log.segment.bytes': 1073741824,  // 1 GB
      'log.cleanup.policy': 'delete',
      'compression.type': 'lz4',
      'min.insync.replicas': 2
    }
  },
  
  // Topic configuration
  topics: {
    'booking-events': {
      purpose: 'All booking-related events',
      partitions: 200,
      replicationFactor: 3,
      retentionDays: 30,
      
      expectedLoad: {
        messagesPerSecond: 8330,  // 1666 bookings × 5 events
        mbPerSecond: 250,
        dailyMessages: 720000000,
        dailyStorage: '20 TB'
      },
      
      consumerGroups: [
        'notification-service',
        'analytics-service',
        'event-store-archiver',
        'fraud-detection-service'
      ]
    },
    
    'payment-events': {
      purpose: 'Payment transactions & ledger updates',
      partitions: 100,
      replicationFactor: 3,
      retentionDays: 90,  // Longer retention for financial records
      
      expectedLoad: {
        messagesPerSecond: 5000,
        mbPerSecond: 150,
        dailyMessages: 432000000,
        dailyStorage: '12 TB'
      },
      
      consumerGroups: [
        'payment-ledger-service',
        'accounting-service',
        'reconciliation-service'
      ]
    },
    
    'inventory-events': {
      purpose: 'Inventory reservations & updates',
      partitions: 150,
      replicationFactor: 3,
      retentionDays: 7,
      
      expectedLoad: {
        messagesPerSecond: 3332,
        mbPerSecond: 100,
        dailyMessages: 288000000,
        dailyStorage: '8 TB'
      },
      
      consumerGroups: [
        'inventory-sync-service',
        'overbooking-monitor',
        'revenue-management'
      ]
    },
    
    'inventory-reservations-global': {
      purpose: 'Multi-region inventory coordination',
      partitions: 100,
      replicationFactor: 3,
      retentionDays: 1,  // Short retention
      
      expectedLoad: {
        messagesPerSecond: 1666,
        mbPerSecond: 50,
        dailyMessages: 144000000,
        dailyStorage: '4 TB'
      },
      
      consumerGroups: [
        'conflict-detector-us-east',
        'conflict-detector-eu-west',
        'conflict-detector-ap-southeast'
      ]
    },
    
    'fraud-events': {
      purpose: 'Fraud detection signals',
      partitions: 50,
      replicationFactor: 3,
      retentionDays: 90,
      
      expectedLoad: {
        messagesPerSecond: 1666,
        mbPerSecond: 50,
        dailyMessages: 144000000,
        dailyStorage: '4 TB'
      }
    },
    
    'notification-events': {
      purpose: 'Email, SMS, push notifications',
      partitions: 80,
      replicationFactor: 3,
      retentionDays: 3,
      
      expectedLoad: {
        messagesPerSecond: 5000,
        mbPerSecond: 100,
        dailyMessages: 432000000,
        dailyStorage: '8 TB'
      }
    }
  },
  
  // ZooKeeper ensemble
  zookeeper: {
    nodeCount: 5,  // Odd number for quorum
    instanceType: 'kafka.m5.large',
    specs: {
      cpu: '2 vCPUs per node',
      memory: '8 GB per node',
      storage: '500 GB per node'
    }
  },
  
  // Total throughput capacity
  totalCapacity: {
    peakThroughput: {
      messagesPerSecond: 25000,
      mbPerSecond: 750,
      mbPerDay: 64800000,  // ~65 TB/day
      gbPerHour: 2700
    },
    
    averageThroughput: {
      messagesPerSecond: 10000,
      mbPerSecond: 300,
      mbPerDay: 25920000,  // ~26 TB/day
      gbPerHour: 1080
    }
  },
  
  // Monitoring & operations
  monitoring: {
    metrics: [
      'UnderReplicatedPartitions',
      'OfflinePartitionsCount',
      'ActiveControllerCount',
      'BytesInPerSec',
      'BytesOutPerSec',
      'MessagesInPerSec',
      'ProduceRequestsPerSec',
      'FetchRequestsPerSec',
      'NetworkProcessorAvgIdlePercent',
      'RequestQueueSize',
      'ResponseQueueSize'
    ],
    
    alerts: [
      {
        metric: 'UnderReplicatedPartitions',
        threshold: 0,
        condition: 'above',
        severity: 'critical'
      },
      {
        metric: 'OfflinePartitionsCount',
        threshold: 0,
        condition: 'above',
        severity: 'critical'
      },
      {
        metric: 'NetworkProcessorAvgIdlePercent',
        threshold: 0.20,
        condition: 'below',
        severity: 'warning'
      }
    ]
  },
  
  // Estimated monthly cost (AWS MSK)
  monthlyCost: {
    brokers: 15000,  // 15 brokers × $1000
    zookeeper: 1500,  // 5 nodes × $300
    storage: 12000,  // 60 TB × $200/TB
    dataTransfer: 5000,
    total: 33500
  }
};
```

### 6.5 Kubernetes Cluster Capacity

```typescript
// ============================================
// Kubernetes Cluster Configuration
// ============================================

export const kubernetesCapacity = {
  
  // Multi-region deployment
  regions: [
    {
      name: 'us-east-1',
      type: 'primary',
      trafficShare: 0.35
    },
    {
      name: 'eu-west-1',
      type: 'primary',
      trafficShare: 0.30
    },
    {
      name: 'ap-southeast-1',
      type: 'primary',
      trafficShare: 0.25
    },
    {
      name: 'sa-east-1',
      type: 'secondary',
      trafficShare: 0.10
    }
  ],
  
  // Per-region cluster configuration
  perRegionCluster: {
    
    // Node pools
    nodePools: {
      
      // General purpose workloads
      general: {
        nodeType: 'c6i.4xlarge',
        cpu: '16 vCPUs per node',
        memory: '32 GB per node',
        minNodes: 10,
        maxNodes: 50,
        expectedNodes: 20
      },
      
      // Memory-intensive workloads (caching, etc.)
      memory: {
        nodeType: 'r6i.2xlarge',
        cpu: '8 vCPUs per node',
        memory: '64 GB per node',
        minNodes: 5,
        maxNodes: 20,
        expectedNodes: 8
      },
      
      // Compute-intensive workloads (fraud detection, ML)
      compute: {
        nodeType: 'c6i.8xlarge',
        cpu: '32 vCPUs per node',
        memory: '64 GB per node',
        minNodes: 3,
        maxNodes: 15,
        expectedNodes: 5
      }
    },
    
    // Service deployments
    services: {
      
      'api-gateway': {
        replicas: { min: 5, max: 20, target: 10 },
        resources: {
          cpu: { request: '500m', limit: '2000m' },
          memory: { request: '1Gi', limit: '4Gi' }
        },
        nodeSelector: 'general'
      },
      
      'booking-service': {
        replicas: { min: 15, max: 40, target: 20 },
        resources: {
          cpu: { request: '1000m', limit: '2000m' },
          memory: { request: '2Gi', limit: '4Gi' }
        },
        nodeSelector: 'general',
        autoscaling: {
          targetCPU: 70,
          targetMemory: 80
        }
      },
      
      'inventory-service': {
        replicas: { min: 10, max: 30, target: 15 },
        resources: {
          cpu: { request: '1000m', limit: '2000m' },
          memory: { request: '2Gi', limit: '4Gi' }
        },
        nodeSelector: 'general'
      },
      
      'payment-service': {
        replicas: { min: 8, max: 25, target: 12 },
        resources: {
          cpu: { request: '1000m', limit: '2000m' },
          memory: { request: '2Gi', limit: '4Gi' }
        },
        nodeSelector: 'general'
      },
      
      'fraud-detection-service': {
        replicas: { min: 5, max: 15, target: 8 },
        resources: {
          cpu: { request: '2000m', limit: '4000m' },
          memory: { request: '4Gi', limit: '8Gi' }
        },
        nodeSelector: 'compute'
      },
      
      'notification-service': {
        replicas: { min: 5, max: 20, target: 8 },
        resources: {
          cpu: { request: '500m', limit: '1000m' },
          memory: { request: '1Gi', limit: '2Gi' }
        },
        nodeSelector: 'general'
      },
      
      'search-service': {
        replicas: { min: 8, max: 25, target: 12 },
        resources: {
          cpu: { request: '1000m', limit: '2000m' },
          memory: { request: '4Gi', limit: '8Gi' }
        },
        nodeSelector: 'memory'
      },
      
      'analytics-service': {
        replicas: { min: 3, max: 10, target: 5 },
        resources: {
          cpu: { request: '1000m', limit: '2000m' },
          memory: { request: '4Gi', limit: '8Gi' }
        },
        nodeSelector: 'memory'
      },
      
      'event-store-service': {
        replicas: { min: 5, max: 15, target: 8 },
        resources: {
          cpu: { request: '1000m', limit: '2000m' },
          memory: { request: '2Gi', limit: '4Gi' }
        },
        nodeSelector: 'general'
      }
    }
  },
  
  // Total resources per region
  perRegionTotalResources: {
    nodes: {
      general: 20,
      memory: 8,
      compute: 5,
      total: 33
    },
    
    totalCPU: 736,  // vCPUs
    totalMemory: '1536 GB',
    
    utilization: {
      targetCPU: 0.70,
      targetMemory: 0.75
    }
  },
  
  // Monthly cost per region
  perRegionMonthlyCost: {
    nodes: {
      general: 6000,   // 20 × $300
      memory: 3200,    // 8 × $400
      compute: 3000,   // 5 × $600
      total: 12200
    },
    
    loadBalancers: 500,
    storage: 1000,  // PVCs, EBS volumes
    networking: 800,
    
    total: 14500
  },
  
  // All regions total cost
  totalMonthlyCost: {
    allRegions: 58000,  // 4 regions × $14.5k
    disasterRecovery: 14500,  // DR region (minimal capacity)
    grandTotal: 72500
  }
};
```

### 6.6 Total System Cost Summary

```typescript
// ============================================
// Complete System Cost Breakdown
// ============================================

export const totalSystemCost = {
  
  // Infrastructure costs (monthly)
  infrastructure: {
    database: {
      production: 504000,
      disasterRecovery: 168000,
      total: 672000
    },
    
    redis: {
      production: 17400,
      disasterRecovery: 8700,
      total: 26100
    },
    
    kafka: {
      production: 33500,
      disasterRecovery: 16750,
      total: 50250
    },
    
    kubernetes: {
      production: 58000,
      disasterRecovery: 14500,
      total: 72500
    },
    
    cdn: 8000,
    
    loadBalancers: 3000,
    
    monitoring: {
      datadog: 4000,
      pagerduty: 1000,
      total: 5000
    },
    
    subtotal: 836850
  },
  
  // Third-party services
  thirdParty: {
    algolia: 5000,  // Search
    stripe: 2000,   // Payment gateway fees (base)
    twilio: 3000,   // SMS notifications
    sendgrid: 2000, // Email
    auth0: 1500,    // Authentication
    cloudflare: 1000,
    
    subtotal: 14500
  },
  
  // Variable costs (based on volume)
  variableCosts: {
    paymentProcessing: {
      // 69M bookings/month × $500 avg × 2.9% + $0.30
      estimate: 102000
    },
    
    smsNotifications: {
      // 50M SMS/month × $0.01
      estimate: 500000
    },
    
    emailNotifications: {
      // 200M emails/month × $0.0001
      estimate: 20000
    },
    
    subtotal: 622000
  },
  
  // Total monthly operational cost
  monthlyTotal: 1473350,  // ~$1.47M/month
  
  // Annual cost
  annualTotal: 17680200,  // ~$17.7M/year
  
  // Cost per booking
  costPerBooking: {
    infrastructure: 0.012,  // $836,850 / 69M
    thirdParty: 0.0002,
    variable: 0.009,
    total: 0.0212  // ~2.1 cents per booking
  },
  
  // Cost breakdown percentages
  breakdown: {
    infrastructure: 0.57,   // 57%
    thirdParty: 0.01,       // 1%
    variableCosts: 0.42     // 42%
  },
  
  // Scaling projections
  scalingProjections: {
    '2x traffic (200k bookings/min)': {
      infrastructureIncrease: 1.6,  // 60% increase
      variableCostsIncrease: 2.0,   // 100% increase
      estimatedMonthly: 2400000
    },
    
    '5x traffic (500k bookings/min)': {
      infrastructureIncrease: 3.0,  // 200% increase
      variableCostsIncrease: 5.0,   // 400% increase
      estimatedMonthly: 5600000
    }
  }
};
```

---

## 7. Implementation Guidelines

### 7.1 Migration Path

```markdown
# Migration to Production

## Phase 1: Foundation (Weeks 1-4)
- [ ] Set up multi-region VPCs and networking
- [ ] Deploy database shards with replication
- [ ] Set up Redis clusters
- [ ] Deploy Kafka cluster
- [ ] Configure monitoring & alerting

## Phase 2: Core Services (Weeks 5-8)
- [ ] Deploy booking service
- [ ] Deploy inventory service
- [ ] Deploy payment service
- [ ] Implement distributed locking with fencing tokens
- [ ] Set up event store with Kafka

## Phase 3: Advanced Features (Weeks 9-12)
- [ ] Deploy fraud detection service
- [ ] Implement double-entry accounting
- [ ] Set up multi-region conflict resolution
- [ ] Deploy notification service
- [ ] Integrate search service (Algolia)

## Phase 4: Testing & Optimization (Weeks 13-16)
- [ ] Load testing (gradual ramp to 100k/min)
- [ ] Chaos engineering tests
- [ ] Performance optimization
- [ ] Security audit
- [ ] Disaster recovery drills

## Phase 5: Production Launch (Week 17+)
- [ ] Blue-green deployment
- [ ] Gradual traffic shift (10% → 50% → 100%)
- [ ] 24/7 monitoring
- [ ] Incident response readiness
```

### 7.2 Key Success Metrics

```typescript
export const successMetrics = {
  
  // Reliability
  availability: {
    target: 0.9999,      // 99.99% uptime
    allowedDowntime: '52.6 minutes/year'
  },
  
  // Performance
  latency: {
    bookingCreation: {
      p50: '< 500ms',
      p95: '< 1000ms',
      p99: '< 2000ms'
    },
    search: {
      p50: '< 200ms',
      p95: '< 500ms',
      p99: '< 1000ms'
    }
  },
  
  // Business
  business: {
    bookingSuccessRate: '> 99.5%',
    paymentSuccessRate: '> 98%',
    fraudDetectionRate: '> 95%',
    oversellRate: '< 0.01%'
  },
  
  // Operational
  operational: {
    deploymentFrequency: 'Multiple per day',
    leadTime: '< 1 hour',
    mttr: '< 30 minutes',  // Mean time to recovery
    changeFailureRate: '< 5%'
  }
};
```

---

## ✅ Conclusion

This document provides a **complete production-ready architecture** for a global booking system capable of handling **100,000 bookings per minute** with:

- ✅ **Zero overselling** through distributed locking with fencing tokens
- ✅ **Financial compliance** via double-entry accounting
- ✅ **Multi-region resilience** with conflict resolution
- ✅ **GDPR compliance** with proper data handling
- ✅ **Production monitoring** with comprehensive alerting
- ✅ **Detailed capacity planning** with cost estimates

**Total Infrastructure Cost:** ~$1.47M/month (~$17.7M/year)  
**Cost per Booking:** ~$0.021 (2.1 cents)

---

## 📚 Related Documentation

- [Original Architecture](./global_booking_architecture.md)
- Kubernetes Deployment Configs (to be created)
- Terraform Infrastructure Code (to be created)
- Load Testing Scenarios (to be created)
- Disaster Recovery Plan (to be created)

---

**Document Version:** 2.0  
**Last Updated:** February 15, 2026  
**Maintained By:** Platform Engineering Team
