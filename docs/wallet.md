# Wallet System

## Overview

The VRI Wallet enables creators to track earnings, monitor royalty accrual, and request micropayment settlements. Wallets operate on a ledger-based model where every usage event triggers royalty accumulation.

---

## Wallet Lifecycle

```
Creator Registration
        ↓
    Wallet Created (balance = $0)
        ↓
    Audio Generated & Verified
        ↓
    Usage Event Logged
        ↓
    Royalty Accrued (balance += royalty)
        ↓
    Loop: More Usage Events
        ↓
    Balance >= $10 ?
        ├─ NO → Continue accruing
        └─ YES → Enable settlement
        ↓
    Creator Requests Payout
        ↓
    Settlement Processing
        ↓
    Balance Reset to $0
```

---

## Royalty Calculation

### Base Rates

Royalties are platform-specific, calculated per usage event:

```
Platform    Base Rate       Unit
────────────────────────────────────
YouTube     $0.001         per view
Spotify     $0.0003        per stream
TikTok      $0.0002        per video use
Podcast     $0.00005       per download
Twitter     $0.0001        per view
LinkedIn    $0.0001        per view
Default     $0.00001       per generic use
```

### Multipliers

Base rate is adjusted by context:

```
Commercial Use:     2.0x (vs. non-profit/educational)
Regional Multiplier:
  - US/UK/JP:       1.0x (baseline)
  - EU:             0.8x (GDPR compliance cost)
  - Developing:     0.5x (lower willingness to pay)
  
Duration-Based:
  - Full use:       1.0x
  - 30-60sec:       0.7x
  - <30sec:         0.4x

License Type:
  - CC0/Public:     0.1x (free distribution)
  - CC-BY:          0.5x (attribution required)
  - CC-BY-SA:       0.6x (share-alike)
  - Proprietary:    1.0x (full commercial)
```

### Calculation Formula

```
royalty_usdc = base_rate_usd 
             × commercial_multiplier 
             × regional_multiplier 
             × duration_multiplier 
             × license_multiplier 
             × usage_count
             × 100  // Convert to cents (microUSD)

Example:

  Platform: YouTube
  Views: 50,000
  Commercial: true (2.0x)
  Region: US (1.0x)
  Duration: Full (1.0x)
  License: Proprietary (1.0x)
  
  royalty = $0.001 × 2.0 × 1.0 × 1.0 × 1.0 × 50,000 × 100
          = $100 (10,000 cents)
```

---

## Wallet Operations

### Get Wallet Balance

```python
async def get_wallet(creator_id):
    """
    Retrieve current wallet state.
    """
    wallet = await db.wallets.findOne({creator_id})
    
    recent_events = await db.usage_events.find({
        creator_id,
        timestamp: {$gt: now - 86400*30}  // Last 30 days
    }).limit(10)
    
    return {
        creator_id,
        balance_usdc: wallet.balance_usdc,
        balance_formatted: f"${wallet.balance_usdc / 100:.2f}",
        lifetime_earnings_usdc: wallet.lifetime_earnings_usdc,
        pending_settlement: {
            amount_usdc: wallet.balance_usdc,
            enabled: wallet.balance_usdc >= 1000,  // $10 minimum
            next_auto_settle: calculate_auto_settle_time()
        },
        recent_events,
        updated_at: wallet.updated_at
    }
```

### Request Settlement (Payout)

```python
async def request_settlement(creator_id, amount_usdc, payment_method):
    """
    Initiate payout request.
    
    Validates:
    - Balance sufficient
    - Payment method valid
    - Creator verified (KYC)
    """
    
    # 1. Validate balance
    wallet = await db.wallets.findOne({creator_id})
    if wallet.balance_usdc < amount_usdc:
        raise InsufficientBalance()
    
    # 2. Validate KYC
    creator = await db.creators.findOne({creator_id})
    if creator.kyc_status != "verified":
        raise KYCNotCompleted()
    
    # 3. Create immutable transaction record
    tx = await db.transactions.insertOne({
        transaction_id: uuid.uuid4(),
        creator_id,
        amount_usdc,
        status: "pending",
        payment_method,
        created_at: now()
    })
    
    # 4. Debit wallet (atomic)
    await db.wallets.updateOne(
        {creator_id},
        {
            $inc: {balance_usdc: -amount_usdc},
            $set: {last_settlement: now()}
        }
    )
    
    # 5. Process payment
    try:
        if payment_method == "stripe":
            await process_stripe_payout(creator, amount_usdc)
        elif payment_method == "ach":
            await process_ach_payout(creator, amount_usdc)
        elif payment_method == "crypto":
            await process_crypto_payout(creator, amount_usdc)
        
        await db.transactions.updateOne(
            {transaction_id: tx.transaction_id},
            {$set: {status: "completed", completed_at: now()}}
        )
        
    except PaymentError as e:
        # Refund wallet on failure
        await db.wallets.updateOne(
            {creator_id},
            {$inc: {balance_usdc: amount_usdc}}
        )
        await db.transactions.updateOne(
            {transaction_id: tx.transaction_id},
            {$set: {status: "failed", error_message: str(e)}}
        )
        raise
    
    return tx
```

---

## Settlement Methods

### Stripe (ACH, Card)

```
Provider: Stripe Connect

Process:
1. Creator connects Stripe account
2. VRI initiates payout via Stripe API
3. Stripe processes ACH/card transfer
4. Funds arrive in 1-2 business days

Fees:
  - Stripe: 2% (for <$100k/month volume)
  - ACH: 1% additional (vs. card)
  
Minimum: $1 (but we enforce $10)
Maximum: $100,000

Frequency: On-demand (no waiting)
```

### ACH (Direct Bank Transfer)

```
Provider: AWS Payment Cryptography or direct bank processor

Process:
1. Creator provides bank account details
2. VRI initiates ACH debit request
3. Bank processes next business day
4. Funds typically arrive within 1-2 days

Fees:
  - Direct bank fee: ~$0.25 per transaction (we absorb)
  - Stripe processing: 1%
  
Minimum: $100 (for economics)
Maximum: $999,999

Frequency: Weekly batch processing
```

### Crypto (Polygon/Solana)

```
Provider: Polygon (USDC) or Solana

Process:
1. Creator provides wallet address
2. VRI converts USD to stablecoin (off-chain)
3. Send to creator's wallet via blockchain
4. Funds arrive in ~1 minute

Fees:
  - Conversion spread: 0.5%
  - Gas fee: ~$0.01 (Polygon), ~$0.00025 (Solana)
  
Minimum: $10
Maximum: $50,000 (daily rate limit)

Frequency: Real-time

Security: Private key never stored by VRI
```

---

## Payment Security

### Wallet Address Verification

```
Stripe/ACH:
  - Micro-deposit verification (optional)
  - Confirm account holder name matches registration
  
Crypto:
  - Small test transfer first ($1)
  - Creator must confirm receipt
  - Only then enable full payouts
```

### Fraud Detection

```
Anomaly Detection:

1. Sudden increase in earnings
   - Alert: Manual review triggered
   
2. Multiple settlement requests in quick succession
   - Alert: Rate limiting applied (1 per day)
   
3. Settlement to unfamiliar wallet
   - Alert: Email confirmation required
   
4. High-volume platforms unseen before
   - Alert: Platform verification requested
```

---

## Auto-Settlement (Optional)

Creators can opt-in to automatic payouts:

```
Config:
{
  "auto_settle_enabled": true,
  "auto_settle_threshold_usdc": 10000,  // $100
  "auto_settle_frequency": "weekly",    // weekly, biweekly, monthly
  "auto_settle_method": "stripe"
}

Behavior:
- Once per week, if balance >= threshold:
  1. Initiate payout
  2. Process via selected method
  3. Log transaction
  4. Send confirmation email

Opt-out: Creator can disable anytime
```

---

## Transaction History

Creators can query their settlement history:

```json
{
  "transactions": [
    {
      "transaction_id": "txn_abc123",
      "amount_usdc": 10000,
      "amount_formatted": "$100.00",
      "status": "completed",
      "payment_method": "stripe",
      "created_at": 1711892400,
      "completed_at": 1711895600,
      "external_id": "ch_1234abcd",
      "notes": ""
    }
  ],
  "total": 5,
  "summary": {
    "total_settled_usdc": 250000,
    "total_pending_usdc": 5000,
    "avg_settlement_days": 2
  }
}
```

---

## Tax Reporting

### 1099 Generation

For US creators, VRI generates Form 1099-NEC if earnings >= $600/year:

```
Fields:
  - Box 1 (Non-employee compensation): Total yearly earnings
  - Creator's name, address, TIN (Tax ID)
  - VRI's name, address, EIN

Generation: Automated in January, emailed to creator
Download: Available in dashboard year-round
```

### International Tax Compliance

```
Withholding:
  - US Non-residents: 30% federal withholding (can be reduced by treaty)
  - EU creators: Reverse charge (no withholding)
  - Others: Per country regulations

Documentation:
  - W-8BEN form (non-US citizens claiming treaty benefits)
  - W-9 form (US citizens)
  - Creator must provide before payout enabled
```

---

## Fraud Prevention

### Indicators Tracked

```
1. Usage anomalies
   - Sudden 10x spike in views
   - New platform never used before
   - Geographic inconsistencies
   
2. Settlement anomalies
   - Frequent address changes
   - High-frequency small payouts
   - Payment method changes
   
3. Account anomalies
   - New account with high earnings
   - Multiple withdrawals same day
   - Requests flagged by payment processor
   
Thresholds:
  - Risk score > 70: Manual review required
  - Risk score > 90: Block settlement until review
```

### Regulatory Compliance

```
KYC (Know Your Customer):
  - Name verification
  - Address verification
  - Phone verification
  - Government ID (for payouts > $1000)

AML (Anti-Money Laundering):
  - Sanctioned person screening
  - PEP (Politically Exposed Person) check
  - Transaction pattern analysis

Reporting:
  - SAR (Suspicious Activity Report) if needed
  - Monthly aggregated transaction reports
  - Annual audit trail export
```

---

## Wallet State Machine

```
┌──────────────────┐
│  No Wallet       │
│  (New Creator)   │
└────────┬─────────┘
         │ Creator registers
         v
┌──────────────────┐
│  Active          │
│  (Balance: $0)   │
└────────┬─────────┘
         │ Usage events occur
         │ Royalties accrue
         v
┌────────────────────────────────────┐
│  Ready for Settlement              │
│  (Balance >= $10)                  │
└────────┬──────────────────┬────────┘
         │                  │
      Manual            Auto-settle
         │                  │
         v                  v
┌──────────────────┐  ┌──────────────────┐
│  Settlement      │  │  Settlement      │
│  Processing      │  │  Processing      │
└────────┬─────────┘  └────────┬─────────┘
         │                     │
      Success              Success
         │                     │
         v                     v
┌──────────────────────────────────┐
│  Settled                         │
│  (Balance Reset, Tx Confirmed)   │
└──────────────────────────────────┘
         │
         │ More usage
         v
┌────────────────────┐
│  Active (Accruing) │
└────────────────────┘
```

---

## Analytics & Reporting

### Creator Dashboard

```
Metrics displayed:
  - Total earnings (lifetime)
  - Current balance
  - Pending settlement
  - Last payout date + amount
  - Earnings trend (7d, 30d, 90d)
  - Top platforms by earnings
  - Top regions by usage
```

### Admin Monitoring

```
Metrics tracked:
  - Total platform payouts (weekly, monthly)
  - Average time-to-settlement
  - Settlement failure rate
  - Fraud detection alerts
  - Revenue distribution (YouTube vs Spotify vs ...)
```

---

**Next**: See [FAQ](./faq.md) for common questions.
