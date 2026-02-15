# Part 3: The Read Path & Inventory

---

# Chapter 10: Search Service — Finding Needles in Haystacks

## Starting Where You Are: SQL Search

You know how to search a database. You have written queries like this dozens of times:

```sql
SELECT * FROM hotels WHERE name LIKE '%tokyo%' AND price_per_night < 200;
```

It works. You type "tokyo," the database scans the `name` column row by row, checks if each value contains the substring "tokyo," filters on price, and returns matching rows. For a table with 5,000 hotels, this finishes in a few milliseconds. You ship it, your users are happy, and you move on to the next feature.

Now imagine the system we are building. Not 5,000 hotels. **500,000 hotels, 2 million flights, 800,000 rental cars.** Users are not just searching by name — they want hotels within 10 kilometers of the Eiffel Tower, with a pool, rated above 4 stars, priced between $100 and $250 per night, available March 15-20, sorted by guest rating. And they want results in under 200 milliseconds.

That `LIKE '%tokyo%'` query? It is about to fall apart.

## Why SQL LIKE Queries Die at Scale

Let us be precise about what goes wrong. There are three distinct problems, and understanding each one will make the solution feel obvious rather than magical.

### Problem 1: The Full Table Scan

When you write `WHERE name LIKE '%tokyo%'` — note the leading `%` — the database **cannot use an index**. An index is like the alphabetical ordering of a phone book: it helps you find "Smith" instantly because you know to jump to the "S" section. But if someone asks, "Find every name that contains 'mit' somewhere in the middle," there is no shortcut. You have to read every single entry.

```sql
-- This CAN use an index (starts with a known prefix):
SELECT * FROM hotels WHERE name LIKE 'Tokyo%';

-- This CANNOT use an index (wildcard at the start):
SELECT * FROM hotels WHERE name LIKE '%Tokyo%';
-- The database must read EVERY row and check the name column.
-- At 500,000 rows: ~800ms. At 5,000,000 rows: ~8 seconds.
```

> **Key Term:** **Full table scan** — When the database reads every row in a table to evaluate a query, rather than jumping directly to matching rows via an index. It is the database equivalent of reading an entire book to find every mention of the word "castle."

### Problem 2: No Fuzzy Matching

SQL `LIKE` is literal. If a user types "Tokio" instead of "Tokyo," your query returns zero results. If they type "hotels near shibuya," your `LIKE` query searches for that exact substring in the hotel name — it has no concept of geography. SQL was designed for precise, structured queries, not for "find things similar to what the user probably meant."

### Problem 3: Multi-Dimension Filtering Is Expensive

When a user filters by location AND price AND dates AND amenities AND star rating, you end up with a query that joins multiple tables, applies multiple `WHERE` clauses, and sorts by a relevance score you have to compute yourself. Each filter adds cost. At scale, these compound queries push MySQL response times to 2-5 seconds — far beyond what a user will tolerate.

```sql
-- A "real" search query in SQL. This gets ugly fast.
SELECT h.*,
       ST_Distance_Sphere(
         POINT(h.longitude, h.latitude),
         POINT(2.2945, 48.8584)  -- Eiffel Tower
       ) AS distance_m
FROM hotels h
JOIN hotel_amenities ha ON h.id = ha.hotel_id
WHERE ha.amenity IN ('pool', 'wifi', 'parking')
  AND h.price_per_night BETWEEN 100 AND 250
  AND h.star_rating >= 4
  AND h.id NOT IN (
    SELECT hotel_id FROM bookings
    WHERE check_in < '2026-03-20' AND check_out > '2026-03-15'
  )
GROUP BY h.id
HAVING COUNT(DISTINCT ha.amenity) = 3  -- must have ALL three amenities
ORDER BY distance_m ASC, h.star_rating DESC
LIMIT 20;
```

That query involves a geospatial calculation on every row, a subquery against the bookings table, a group-by with a having clause, and a multi-column sort. On a table with 500,000 hotels and millions of bookings, this query takes **3-8 seconds**. Your users have already hit the back button.

> **What If You Skip This?** If you serve search results directly from your transactional database, two things happen as you scale. First, search queries get slow — multi-second response times that kill user experience. Second, those heavy read queries compete with booking writes for database resources. During a traffic spike, your search load can literally slow down payment processing. You need a separate search engine to protect both sides.

## Enter Elasticsearch: Google for Your Data

Elasticsearch is a search engine built specifically for the kinds of queries that make SQL cry. Think of it as Google for your own data. When you type a query into Google, you get results in 200 milliseconds from an index of billions of web pages. Elasticsearch uses the same underlying technology — it is built on Apache Lucene, the same library that powered early Google.

> **Analogy:** Imagine you have a library with 500,000 books. The SQL approach is like having all the books on shelves, sorted by title. Finding all titles that contain "Tokyo" means walking down every aisle, pulling out every book, and checking the title. The Elasticsearch approach is like having a card catalog where someone has already gone through every book, pulled out every significant word, and written down which books contain that word. Want every book mentioning "Tokyo"? Go to the "Tokyo" card. It lists every book instantly. Want "Tokyo" AND "hotel" AND "luxury"? Grab all three cards, find the overlap. Done in milliseconds.

### How Elasticsearch Works: The Inverted Index

The card catalog in our analogy has a formal name: an **inverted index**. It is the single most important concept in search engineering, and it is surprisingly simple.

In a normal database, data is organized by document (row). You look up a hotel and see all its fields:

```
Document-oriented (how MySQL stores it):
  Hotel #1: { name: "Tokyo Grand Hotel", city: "Tokyo", amenities: ["pool", "wifi"] }
  Hotel #2: { name: "Paris Boutique", city: "Paris", amenities: ["wifi", "spa"] }
  Hotel #3: { name: "Tokyo Inn", city: "Tokyo", amenities: ["wifi", "parking"] }
```

An inverted index flips this around. Instead of "document -> words," it stores "word -> documents":

```
Inverted Index (how Elasticsearch stores it):
  "tokyo"    -> [Hotel #1, Hotel #3]
  "grand"    -> [Hotel #1]
  "hotel"    -> [Hotel #1]
  "paris"    -> [Hotel #2]
  "boutique" -> [Hotel #2]
  "inn"      -> [Hotel #3]
  "pool"     -> [Hotel #1]
  "wifi"     -> [Hotel #1, Hotel #2, Hotel #3]
  "spa"      -> [Hotel #2]
  "parking"  -> [Hotel #3]
```

> **Key Term:** **Inverted index** — A data structure that maps each unique term (word, number, location) to the list of documents that contain it. Called "inverted" because it inverts the normal document-to-words relationship into a words-to-documents relationship. It is what makes search engines fast.

Now, when a user searches for "tokyo wifi," Elasticsearch:

1. Looks up "tokyo" in the inverted index: `[Hotel #1, Hotel #3]`
2. Looks up "wifi" in the inverted index: `[Hotel #1, Hotel #2, Hotel #3]`
3. Computes the intersection: `[Hotel #1, Hotel #3]`
4. Returns results in under 5 milliseconds, regardless of whether you have 500 or 500,000 hotels.

This is fundamentally different from SQL. There is no row-by-row scanning. The work was done **at write time** (when you indexed the hotel), not at read time (when the user searches). You pay the cost once when data goes in, and every search reaps the reward.

### Beyond Text: Location, Numbers, and Dates

Elasticsearch does not just handle text. It builds specialized inverted indexes for different data types:

| Data Type | Index Structure | Example Query |
|-----------|----------------|---------------|
| **Text** | Token-based inverted index | "hotels with pool near station" |
| **Geo-point** | Geohash grid / BKD tree | "within 10km of latitude 48.85, longitude 2.29" |
| **Numeric** | BKD tree (sorted intervals) | "price between 100 and 250" |
| **Date** | BKD tree (millisecond precision) | "available from March 15 to March 20" |
| **Keyword** | Exact-match inverted index | "amenities: pool" (no fuzzy matching) |

This is why Elasticsearch can handle our complex query — location + price + dates + amenities + star rating — in a single pass through multiple specialized indexes, returning results in under 200 milliseconds.

---

## The Actual Implementation: Line by Line

Now let us look at the real search code from our system. We will walk through every piece.

### Setting Up the Elasticsearch Client

```typescript
// search-service/src/search.service.ts

import { Client } from '@elastic/elasticsearch';

export class SearchService {
  // Create a connection to Elasticsearch.
  // Think of this like creating a database pool — you do it once
  // when the service starts, then reuse it for every query.
  private readonly esClient = new Client({
    node: process.env.ELASTICSEARCH_URL,       // e.g., 'https://es-cluster:9200'
    auth: { apiKey: process.env.ELASTICSEARCH_API_KEY }  // Authentication
  });
```

This is the equivalent of your `new Pool({ connectionString: ... })` in PostgreSQL. The `Client` object manages connections to the Elasticsearch cluster. You create one instance and use it throughout the service's lifetime.

### The Hotel Search Method

Here is the full search method. Read through it once, then we will break down every parameter:

```typescript
  async searchHotels(params: HotelSearchParams): Promise<SearchResult> {
    const { body } = await this.esClient.search({
      index: 'hotels',     // Which index to search (like a database table)
      body: {
        query: {
          bool: {
            // "must" = all of these conditions MUST match (logical AND)
            must: [
              // 1. GEOGRAPHIC FILTER: Find hotels near these coordinates
              {
                geo_distance: {
                  distance: `${params.radiusKm || 50}km`,  // Search radius
                  location: {                              // Center point
                    lat: params.latitude,                   // e.g., 48.8584
                    lon: params.longitude                   // e.g., 2.2945
                  }
                }
              },
              // 2. DATE FILTER: Hotel must be available for the requested dates
              {
                range: {
                  available_from: { lte: params.checkIn }   // Available FROM
                }                                           // must be <= check-in
              },
              {
                range: {
                  available_to: { gte: params.checkOut }    // Available TO
                }                                           // must be >= check-out
              }
            ],
            // "filter" = additional conditions that MUST match,
            // but do NOT affect the relevance score.
            // We use filter for exact criteria like price range.
            filter: [
              // 3. PRICE FILTER: Only include hotels in the price range
              ...(params.minPrice || params.maxPrice ? [{
                range: {
                  price_per_night: {
                    ...(params.minPrice && { gte: params.minPrice }),  // >= min
                    ...(params.maxPrice && { lte: params.maxPrice })   // <= max
                  }
                }
              }] : []),
              // 4. STAR RATING: Minimum star rating
              ...(params.minStars ? [{
                range: { star_rating: { gte: params.minStars } }
              }] : []),
              // 5. AMENITIES: Must have these specific amenities
              ...(params.amenities?.length ? [{
                terms: { amenities: params.amenities }
              }] : [])
            ]
          }
        },
        // 6. SORTING: How to order the results
        sort: [
          { _score: 'desc' },                              // Best match first
          { popularity_score: 'desc' },                    // Then by popularity
          { price_per_night: params.sortByPrice || 'asc' } // Then by price
        ],
        // 7. PAGINATION
        from: params.offset || 0,   // Skip N results (like SQL OFFSET)
        size: params.limit || 20    // Return N results (like SQL LIMIT)
      }
    });

    return {
      results: body.hits.hits.map(hit => hit._source),  // The actual hotel data
      total: body.hits.total.value,                      // Total matching hotels
      took: body.took                                    // Time in milliseconds
    };
  }
```

That is a lot. Let us unpack it piece by piece.

### Understanding the Query Structure

The heart of every Elasticsearch query is the `bool` query. It has two sections: `must` and `filter`. They both require conditions to be true, but they behave differently in one critical way.

**`must` clauses affect the relevance score.** When you put the geo_distance query in `must`, Elasticsearch does not just check "is this hotel within 50km?" — it also calculates *how close* the hotel is and uses that distance to influence the result ranking. Closer hotels score higher.

**`filter` clauses do not affect the relevance score.** When you filter by price range, a hotel at $100 is not "more relevant" than one at $200 — they both simply pass the filter. Elasticsearch skips the scoring math for filter clauses, which makes them faster.

> **Analogy:** Think of `must` as the essay portion of an exam — it is graded and affects your final score. Think of `filter` as the eligibility check at the door — you either pass (and get to take the exam) or you do not. A filter never adds points to your score.

### The Geo-Distance Query

```typescript
{
  geo_distance: {
    distance: `${params.radiusKm || 50}km`,
    location: {
      lat: params.latitude,
      lon: params.longitude
    }
  }
}
```

This says: "Only return hotels whose `location` field is within `radiusKm` kilometers of the given coordinates." The `location` field in your Elasticsearch index must be mapped as a `geo_point` type. Under the hood, Elasticsearch uses a geohash grid to make this blazingly fast — it does not calculate the distance to every hotel on earth.

In SQL, you would need `ST_Distance_Sphere()` and a row-by-row calculation. In Elasticsearch, the geo-point index structure makes this a near-instant lookup.

### The Range Queries (Dates and Price)

```typescript
// Date availability check
{ range: { available_from: { lte: params.checkIn } } }
{ range: { available_to: { gte: params.checkOut } } }

// Price range check
{ range: { price_per_night: { gte: 100, lte: 250 } } }
```

The `range` query works on numbers and dates. The operators are what you would expect:
- `gte` = greater than or equal to (>=)
- `lte` = less than or equal to (<=)
- `gt` = greater than (>)
- `lt` = less than (<)

This is conceptually identical to `WHERE price_per_night BETWEEN 100 AND 250` in SQL. The difference is performance: Elasticsearch stores numeric fields in a BKD tree (a data structure optimized for range queries), so these lookups are logarithmic, not linear.

### The Terms Query (Amenities)

```typescript
{ terms: { amenities: ['pool', 'wifi', 'parking'] } }
```

The `terms` query checks if a field contains any of the specified values. If the hotel's `amenities` field includes "pool" AND "wifi" AND "parking," it matches. This is the Elasticsearch equivalent of `WHERE amenity IN ('pool', 'wifi', 'parking')`, but without needing a separate join table.

### Sorting and Pagination

```typescript
sort: [
  { _score: 'desc' },            // Primary sort: relevance score
  { popularity_score: 'desc' },  // Secondary sort: popularity
  { price_per_night: 'asc' }     // Tertiary sort: cheapest first
],
from: 0,     // Start from result #0 (first page)
size: 20     // Return 20 results per page
```

Sorting works exactly like `ORDER BY` in SQL. The `_score` field is special — it is Elasticsearch's computed relevance score based on how well the document matched the `must` clauses. The `from` and `size` parameters are identical to SQL's `OFFSET` and `LIMIT`.

### The Response

```typescript
return {
  results: body.hits.hits.map(hit => hit._source),  // Array of hotel objects
  total: body.hits.total.value,                      // Total matches (e.g., 1,247)
  took: body.took                                    // Query time in ms (e.g., 12)
};
```

Elasticsearch returns results inside `body.hits.hits`, where each hit has a `_source` property containing the original document. The `total` tells you how many documents matched across the entire index (useful for pagination: "showing 1-20 of 1,247 results"). The `took` field tells you how long the query took in milliseconds — this is invaluable for monitoring.

---

## Keeping the Index in Sync: The CQRS Pattern

Now you might be asking: "If the real hotel data lives in MySQL and Elasticsearch is just for search, how do they stay in sync?"

Great question. This is the **CQRS pattern** — Command Query Responsibility Segregation. It is a fancy name for a simple idea: **writes go to one place, reads come from another.**

> **Key Term:** **CQRS (Command Query Responsibility Segregation)** — A pattern where the system that handles writes (commands) is separate from the system that handles reads (queries). In our case, hotel data is written to MySQL and read from Elasticsearch. They are kept in sync through events.

Here is how it works in our system:

1. A hotel partner updates their room price in MySQL (the write/command side).
2. That update triggers a Kafka event: `hotel.updated`.
3. The Search Service consumes the event and updates Elasticsearch (the read/query side).

```typescript
  // This method is called when we receive a Kafka event
  // telling us a hotel's data has changed.
  async updateHotelIndex(event: HotelUpdatedEvent): Promise<void> {
    await this.esClient.update({
      index: 'hotels',                          // Which index
      id: event.hotelId.toString(),             // Which document (by hotel ID)
      body: {
        doc: {
          // Only update the fields that changed —
          // Elasticsearch merges this with the existing document.
          price_per_night: event.basePrice,
          available_rooms: event.availableQuantity,
          updated_at: new Date().toISOString()
        }
      }
    });
  }
```

The `esClient.update()` call does a partial update — it merges the new fields into the existing document without replacing the entire thing. This is efficient because you only send the fields that changed.

> **What If You Skip This?** If you try to serve search queries directly from MySQL, you create two problems. First, your search experience degrades — SQL cannot match Elasticsearch's speed for complex, multi-filter queries. Second, you create resource contention — heavy search queries compete with booking writes for database connections and CPU. During a flash sale, your search load can make payment processing slow. A separate search engine protects your critical write path.

### Is the Data Always Perfectly in Sync?

No. And that is okay.

There is a brief delay between when a hotel's price changes in MySQL and when that change appears in Elasticsearch. This delay — typically a few hundred milliseconds to a few seconds — is called **eventual consistency**. The data *will* be consistent, just not *immediately*.

> **Key Term:** **Eventual Consistency** — A consistency model where, after a write to one system, other systems (like read replicas or search indexes) will eventually reflect that write, but not necessarily immediately. There is a window — typically milliseconds to seconds — where different systems may return different values for the same data. This trade-off is fundamental to distributed systems: you gain availability and performance at the cost of brief staleness.

For search results, this is perfectly acceptable. If a hotel's price changed 500 milliseconds ago but the search results still show the old price, no real harm is done. When the user clicks through to the booking page, the Booking Service reads the authoritative price from MySQL, not from Elasticsearch. The search engine's job is to help users *find* things quickly, not to be the source of truth for transactions.

> **Analogy:** Think about Google Search. When you publish a new web page, Google does not show it in search results instantly. It takes minutes, hours, sometimes days to index the new page. But nobody complains because the search results are "good enough" — they help you find what you need, even if the very latest page is not there yet. Our search works the same way.

---

## Why We Need Both: The Database AND the Search Engine

This question comes up in every conversation about Elasticsearch: "If Elasticsearch is so fast, why not just use it as the database and skip MySQL entirely?"

Here is why you need both:

| Capability | MySQL | Elasticsearch |
|-----------|-------|---------------|
| **ACID Transactions** | Yes — BEGIN, COMMIT, ROLLBACK | No — no multi-document transactions |
| **Data Integrity** | Foreign keys, constraints, triggers | None — no relational enforcement |
| **Complex Joins** | Yes — JOIN across tables | Limited — denormalized documents only |
| **Full-Text Search** | Slow (LIKE, FULLTEXT) | Blazing fast (inverted index) |
| **Geo Queries** | Possible but slow | Native, optimized |
| **Fuzzy Matching** | No | Yes ("Tokio" finds "Tokyo") |
| **Aggregations** | GROUP BY (decent) | Extremely powerful, real-time |
| **Durability** | Primary concern — data never lost | Secondary — can be rebuilt from MySQL |
| **Write Speed** | Optimized for writes | Optimized for reads |

MySQL is your **source of truth** — the authoritative record. When money changes hands or inventory is decremented, that happens in MySQL with full ACID guarantees.

Elasticsearch is your **search accelerator** — a read-optimized copy of a subset of your data. If Elasticsearch crashes and loses its data, you rebuild the index from MySQL. No booking is lost. No payment is affected. Search is down for a few minutes, which is vastly better than losing transaction data.

> **Key Term:** **Source of truth** — The one authoritative system where a piece of data is definitively stored. Other systems may have copies, but when there is a conflict, the source of truth wins. In our architecture, MySQL is the source of truth for booking and inventory data; Elasticsearch is a derived, read-optimized projection of that data.

---

## Chapter 10 Summary

| Concept | One-Sentence Summary |
|---------|---------------------|
| SQL LIKE limitations | Leading-wildcard LIKE queries cannot use indexes, causing full table scans that get slower as data grows. |
| Inverted index | A data structure that maps terms to documents, enabling instant lookups instead of row-by-row scanning. |
| Elasticsearch | A search engine built on inverted indexes that handles text, geo, numeric, and date queries in milliseconds. |
| Bool query: must vs. filter | `must` clauses affect relevance scoring; `filter` clauses are pass/fail checks that run faster. |
| Geo-distance query | Finds documents within a radius of a geographic point using geohash-based indexes. |
| CQRS | Writes go to MySQL (source of truth); reads go to Elasticsearch (fast search). Sync happens via Kafka events. |
| Eventual consistency | The search index lags behind MySQL by milliseconds to seconds, which is acceptable for search results. |
| Why both MySQL and ES | MySQL guarantees transactions and data integrity. Elasticsearch provides fast, flexible search. Each is essential. |

> **Checkpoint:** Without scrolling back, answer these three questions: (1) Why can't a SQL `LIKE '%tokyo%'` query use an index? (2) What is an inverted index and how does it make search fast? (3) In our system, what is the source of truth — MySQL or Elasticsearch — and how do they stay in sync? If you can explain all three to a colleague, you are ready for Chapter 11.

---

---

# Chapter 11: Inventory Management — Guarding the Last Room

This is the chapter where things get real. Up until now, most patterns we have discussed are about performance and organization — make things faster, keep code clean, separate concerns. Inventory management is different. Get this wrong, and you sell the same hotel room to two families. One of them shows up and has no place to sleep. Your company pays for their alternative accommodation, issues a refund, and eats the reputation damage.

This is not hypothetical. It happens to real companies, and it happens because of a bug that takes about six lines of code to write.

## The Naive Approach: Just UPDATE the Count

Let us start with what you would naturally write. You have an `inventory` table:

```sql
CREATE TABLE inventory (
  id BIGINT PRIMARY KEY,
  resource_type VARCHAR(20),   -- 'hotel', 'flight', 'car'
  resource_id BIGINT,          -- which hotel, which flight
  resource_date DATE,          -- which night
  total_quantity SMALLINT,     -- total rooms in the hotel
  available_quantity SMALLINT, -- rooms still available
  reserved_quantity SMALLINT   -- rooms currently held/booked
);
```

And you write a booking endpoint that decrements the count:

```typescript
// The NAIVE approach — DO NOT USE IN PRODUCTION
app.post('/api/book', async (req, res) => {
  const { resourceId, resourceDate } = req.body;

  // Step 1: Check if there is availability
  const [rows] = await db.execute(
    'SELECT available_quantity FROM inventory WHERE resource_id = ? AND resource_date = ?',
    [resourceId, resourceDate]
  );

  if (rows[0].available_quantity <= 0) {
    return res.status(409).json({ error: 'No rooms available' });
  }

  // Step 2: Decrement the count
  await db.execute(
    'UPDATE inventory SET available_quantity = available_quantity - 1 WHERE resource_id = ? AND resource_date = ?',
    [resourceId, resourceDate]
  );

  return res.status(200).json({ message: 'Booked!' });
});
```

This looks correct. Check availability, then update the count. Simple CRUD. You have written code like this a hundred times.

It has a horrifying bug.

## The Race Condition: Two Users, One Room

Imagine the last room is available. Two users click "Book Now" at almost the same instant. Here is what happens, millisecond by millisecond:

```
TIME    USER A                              USER B
────    ──────                              ──────
0ms     SELECT available_quantity → 1
1ms                                         SELECT available_quantity → 1
        (User A hasn't written yet,         (User B reads the SAME value.
         so the database still says 1)       The room looks available.)

5ms     UPDATE SET available = 0
        (Success! Room booked.)

6ms                                         UPDATE SET available = -1
                                            (Also "succeeds"! Now available
                                             is NEGATIVE. Two bookings for
                                             one room.)

RESULT: Double booking. One family arrives to find their room occupied.
```

> **Key Term:** **Race condition** — A bug that occurs when the outcome of a program depends on the timing of events (like two requests arriving at the same moment). The code is "correct" when run sequentially but breaks when run concurrently. Race conditions are notoriously hard to catch in testing because they only appear under specific timing.

The gap between "read the count" and "update the count" — Steps 1 and 2 in our naive code — is the window where the race condition lives. At low traffic, the window is rarely hit. At 100,000 bookings per minute, it is hit constantly.

> **Analogy:** Imagine a parking garage with one spot left. The sign at the entrance says "1 SPOT AVAILABLE." Two cars approach from different streets at the same time. Both drivers see the sign (it still says 1 because neither has parked yet), both drive in, and both try to park in the same spot. One of them is going to have a very bad day. The problem is that the sign (reading the count) and parking the car (changing the count) are separate actions, and another car can sneak in between.

### "Just Use a Transaction!"

Your instinct might be to wrap it in a transaction with `SELECT ... FOR UPDATE`:

```sql
BEGIN;
SELECT available_quantity FROM inventory
  WHERE resource_id = 42 AND resource_date = '2026-03-15'
  FOR UPDATE;              -- Lock this row. Nobody else can read or write it.
-- ... check if available > 0 ...
UPDATE inventory SET available_quantity = available_quantity - 1
  WHERE resource_id = 42 AND resource_date = '2026-03-15';
COMMIT;                    -- Release the lock.
```

This **does** fix the race condition. While User A holds the lock, User B waits. When A finishes, B gets the lock, reads the updated count (now 0), and correctly gets a "no rooms available" response.

But there is a cost. Every booking for the same resource on the same date must go through this lock **one at a time**. At high concurrency — say, 500 people trying to book the same popular hotel on New Year's Eve — they all queue up, and each one waits for the previous one to finish. Your 5ms operation now takes 500 * 5ms = 2.5 seconds for the last person in line. That is unacceptable.

We need a pattern that is both correct (no double bookings) and fast (does not serialize every request).

## The Hold Pattern: Reserve First, Confirm Later

Instead of immediately decrementing inventory with a "book" call, we split the process into two phases:

1. **Create a Hold** — temporarily reserve the inventory. The hold has a time limit (TTL). If the booking is not confirmed within that window, the hold automatically expires and the inventory goes back to the pool.
2. **Confirm the Hold** — once payment succeeds, convert the hold into a permanent booking.

> **Analogy:** Think of shopping online. When you add an item to your cart, the store does not immediately charge you. Instead, it places a temporary hold on that item so nobody else can buy it while you are entering your credit card details. If you abandon your cart and walk away, the hold expires after 10 minutes, and the item goes back on the shelf. That is exactly what our hold pattern does with hotel rooms.

This pattern gives us three critical properties:

1. **No double bookings.** The hold atomically decrements the available count. Two users cannot hold the same last room.
2. **No stuck inventory.** If a user abandons the booking flow, the TTL ensures the room goes back to the pool automatically.
3. **Separation of concerns.** The Inventory Service handles holds. The Booking Service handles payment. They do not need to know each other's internals.

## The Hold State Machine

Every hold moves through a defined set of states. There are no surprise transitions — the rules are explicit.

```
                 ┌────────┐
                 │ (none) │
                 └───┬────┘
                     │
                  createHold()
                     │
                 ┌───v────┐
            ┌───>│ active │<────┐
            │    └───┬────┘     │
            │        │          │
       extendTTL()   │    (hold still valid)
            │        │
            └────────┼──────────┬──────────┬──────────┐
                     │          │          │          │
                confirm()   expire()   release()   cancel()
                     │          │          │          │
              ┌──────v──┐  ┌───v────┐  ┌──v───────┐  ┌──v───────┐
              │confirmed│  │expired │  │released  │  │cancelled │
              └─────────┘  └────────┘  └──────────┘  └──────────┘
```

> **Key Term:** **State machine** — A model where an entity (like a hold) has a defined set of states and a defined set of transitions between them. A hold can go from `active` to `confirmed`, but it can never go from `expired` to `active`. The state machine makes invalid transitions impossible by design, not by accident.

Here is what each state means:

| State | Meaning | How It Gets Here | What Happens to Inventory |
|-------|---------|-----------------|--------------------------|
| **active** | Room is temporarily reserved | `createHold()` called | available_quantity decreased |
| **confirmed** | Booking is final, payment succeeded | `confirmHold()` called | Inventory stays decremented (the room is really booked) |
| **expired** | User did not complete booking in time | TTL ran out, cleanup job ran | available_quantity restored |
| **released** | User or system explicitly cancelled | `releaseHold()` called | available_quantity restored |
| **cancelled** | Business logic cancelled the hold | Saga compensation triggered | available_quantity restored |

Notice three of the four terminal states (expired, released, cancelled) **restore inventory**. Only `confirmed` keeps the room booked. This means inventory cannot leak — every room held will eventually either become a booking or return to the pool.

> **What If You Skip This?** Without a state machine, your hold statuses are just strings — and developers will set them to whatever seems right in the moment. You end up with holds stuck in "pending" forever, inventory that is held but never confirmed or released, and ghost rooms that no one can book because they are reserved by an abandoned session. The state machine prevents all of this by making invalid transitions impossible.

## Fencing Tokens: The Deli Counter Ticket

Before we dive into the implementation, you need to understand **fencing tokens**. This is a concept from distributed systems that solves a subtle but devastating problem.

> **Analogy:** You walk into a busy deli. There is a ticket machine at the door. You pull a ticket: number 47. The person before you has ticket 46. The rule is simple: the counter only serves ticket numbers that are **higher** than the last one served. If someone walks up with ticket 43 (an old ticket, maybe they went to the bathroom and came back), the counter says "sorry, we have already moved past 43." The ticket number always increases, and old tickets are always rejected.

In our system, a fencing token is a monotonically increasing number attached to every inventory operation. Here is why we need it.

Imagine this scenario without fencing tokens:

```
TIME    OPERATION
────    ─────────
0ms     User A creates hold. Sets available_quantity = 9.
100ms   Network glitch. The "set available = 9" message gets delayed.
200ms   User B creates hold. Sets available_quantity = 8.
300ms   The delayed message from User A finally arrives.
        Sets available_quantity = 9 again!
        User B's hold has been silently erased. Double booking possible.
```

With fencing tokens, every operation carries a token number that must be **higher** than the currently stored token. If a stale (lower-numbered) operation arrives late, the database rejects it because its token is older:

```
TIME    OPERATION                              FENCING TOKEN
────    ─────────                              ─────────────
0ms     User A creates hold. Token = 47.       Stored: 47
200ms   User B creates hold. Token = 48.       Stored: 48
300ms   Delayed operation from A. Token = 47.  REJECTED (47 < 48)
        The stale write is harmless.
```

> **Key Term:** **Fencing token** — A monotonically increasing number assigned to each operation on a shared resource. The resource only accepts operations with a token higher than the last one it processed. This prevents stale or delayed operations from corrupting the current state.

This is the critical line in the implementation that enforces fencing:

```sql
UPDATE inventory
SET reserved_quantity = reserved_quantity + ?,
    available_quantity = available_quantity - ?,
    fencing_token = ?, updated_at = NOW()
WHERE resource_type = ? AND resource_id = ? AND resource_date = ?
AND available_quantity >= ?
AND (fencing_token IS NULL OR fencing_token < ?)
--                                          ^^^
-- This condition rejects any operation whose token is not
-- strictly greater than the currently stored token.
```

If the `UPDATE` affects zero rows, it means either there is not enough inventory (`available_quantity < requested`) or the fencing token is stale (`fencing_token >= new_token`). Either way, the operation is correctly rejected.

---

## The InventoryHoldService: Line by Line

Now let us walk through the actual implementation. This is the most important service in the system for correctness. Every line matters.

### createHold() — Reserving Inventory

```typescript
export class InventoryHoldService {

  async createHold(params: {
    resourceType: string;    // 'hotel', 'flight', 'car'
    resourceId: bigint;      // Which specific hotel/flight/car
    resourceDate: Date;      // Which date
    quantity: number;         // How many rooms/seats
    userId: bigint;          // Who is booking
    sessionId: string;       // Browser session (detect duplicate holds)
    ttlSeconds: number;      // How long the hold lasts (e.g., 600 = 10 minutes)
  }): Promise<InventoryHold> {

    // Generate a globally unique ID for this hold.
    // UUID v4 = random, virtually impossible to collide.
    const holdUuid = randomUUID();

    // Calculate when this hold expires.
    // Date.now() gives milliseconds, so we multiply ttlSeconds by 1000.
    const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);

    // Get the next fencing token for this specific resource+date combo.
    // This is an atomically incrementing counter (our deli counter ticket).
    const fencingToken = await this.getNextFencingToken(
      params.resourceType, params.resourceId, params.resourceDate
    );
```

We start by preparing three things: a unique hold ID, an expiration timestamp, and a fencing token. The fencing token comes from a separate counter (think of a `SELECT ... FOR UPDATE` on a counter row or a Redis `INCR` command) that guarantees every token is strictly increasing.

```typescript
    // Get a database connection from the pool.
    // We need a dedicated connection because we are about to run
    // multiple queries inside a single transaction.
    const connection = await db.getConnection();

    try {
      // Start the transaction. Everything inside will either
      // ALL succeed (commit) or ALL be undone (rollback).
      await connection.beginTransaction();
```

This is your familiar `BEGIN` — we need ACID guarantees here because we are reading and writing multiple tables and they must stay consistent.

```typescript
      // STEP 1: Check if this user already has an active hold
      // for this exact resource on this exact date.
      // Why? If they refreshed the page or clicked "Book" twice,
      // we do not want to create a SECOND hold. We extend the first one.
      const [existing] = await connection.execute(`
        SELECT id FROM inventory_holds
        WHERE user_id = ? AND session_id = ?
        AND resource_type = ? AND resource_id = ? AND resource_date = ?
        AND status = 'active'
      `, [params.userId, params.sessionId, params.resourceType,
          params.resourceId, params.resourceDate]);

      if (existing.length > 0) {
        // User already has a hold. Just extend the timer.
        await connection.execute(
          'UPDATE inventory_holds SET expires_at = ? WHERE id = ?',
          [expiresAt, existing[0].id]
        );
        await connection.commit();
        return this.getHoldById(existing[0].id);
      }
```

This is an **idempotency check**. In distributed systems, messages can arrive twice, users can double-click, and network retries can duplicate requests. Instead of creating duplicate holds (which would double-count reserved inventory), we detect the duplicate and simply extend the existing hold's TTL. The user stays on their booking page, and the system does the right thing silently.

> **Key Term:** **Idempotency** — An operation is idempotent if performing it twice produces the same result as performing it once. Extending an existing hold is idempotent. Creating a second hold for the same room is not.

```typescript
      // STEP 2: Reserve the inventory.
      // This is the critical UPDATE with the fencing token check.
      const [result] = await connection.execute(`
        UPDATE inventory
        SET reserved_quantity = reserved_quantity + ?,
            available_quantity = available_quantity - ?,
            fencing_token = ?, updated_at = NOW()
        WHERE resource_type = ? AND resource_id = ? AND resource_date = ?
        AND available_quantity >= ?
        AND (fencing_token IS NULL OR fencing_token < ?)
      `, [params.quantity, params.quantity, fencingToken,
          params.resourceType, params.resourceId, params.resourceDate,
          params.quantity, fencingToken]);
```

This single `UPDATE` statement does three things atomically:

1. **Checks availability** — `available_quantity >= ?` ensures we do not overbook.
2. **Checks the fencing token** — `fencing_token IS NULL OR fencing_token < ?` ensures stale operations are rejected.
3. **Decrements inventory** — `available_quantity - ?` and `reserved_quantity + ?` move units from "available" to "reserved."

If **any** of these checks fail, the `UPDATE` affects zero rows. That is how we detect failure:

```typescript
      if (result.affectedRows === 0) {
        // Either not enough inventory, or the fencing token was stale.
        // Either way, this hold cannot proceed.
        throw new InsufficientInventoryError('Not enough inventory available');
      }
```

No double booking. No race condition. The database's own row-level locking ensures that only one `UPDATE` on this row can run at a time, and the fencing token condition rejects stale writes. This is the one line of defense that makes the entire system safe.

```typescript
      // STEP 3: Create the hold record.
      // This is the receipt — proof that inventory was reserved,
      // who reserved it, when it expires, and the fencing token
      // that was used.
      const [holdResult] = await connection.execute(`
        INSERT INTO inventory_holds (
          hold_uuid, resource_type, resource_id, resource_date,
          quantity, user_id, session_id, fencing_token,
          region, status, expires_at, hold_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 'user_booking')
      `, [holdUuid, params.resourceType, params.resourceId,
          params.resourceDate, params.quantity, params.userId,
          params.sessionId, fencingToken, process.env.REGION, expiresAt]);

      const holdId = holdResult.insertId;
```

The status starts as `'active'` — the first state in our state machine. The `hold_reason` tells us why this hold exists (a user booking, as opposed to an admin block or a maintenance hold). The `region` field supports multi-region deployments — we will cover that in a later chapter.

```typescript
      // STEP 4: Log the state transition.
      // Every state change is recorded in a separate table.
      // This is your audit trail — when debugging why a hold
      // ended up in a particular state, you follow the transitions.
      await connection.execute(`
        INSERT INTO inventory_hold_transitions (
          hold_id, from_status, to_status, transition_reason, transitioned_by
        ) VALUES (?, 'none', 'active', 'Hold created by user', ?)
      `, [holdId, `user:${params.userId}`]);
```

This transition log table is invaluable for debugging. When a customer support agent asks "what happened to the hold on room 42 for March 15?", you can trace the full history: created at 14:01:03, extended at 14:05:22, confirmed at 14:07:45 — or expired at 14:11:03 because the user never completed payment.

```typescript
      // STEP 5: Write to the outbox table.
      // This is the Transactional Outbox Pattern.
      // Instead of publishing a Kafka event directly (which could fail
      // after the DB commit, leaving us in an inconsistent state),
      // we write the event to an outbox table INSIDE the same transaction.
      // A separate process reads the outbox and publishes to Kafka.
      await connection.execute(`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, topic, partition_key
        ) VALUES ('inventory_hold', ?, 'inventory.hold_created', ?, 'inventory-events', ?)
      `, [holdId, JSON.stringify({ holdId, holdUuid, ...params, fencingToken, expiresAt }),
          `${params.resourceType}:${params.resourceId}`]);

      await connection.commit();
      return this.getHoldById(holdId);
```

> **Key Term:** **Transactional Outbox** — A pattern where events are written to a database table (the "outbox") within the same transaction as the business data change. A separate process later reads the outbox and publishes the events to Kafka. This guarantees that the event is published if and only if the data change was committed. No orphaned events, no lost events.

```typescript
    } catch (error) {
      // If ANYTHING went wrong, undo everything.
      // The inventory decrement, the hold record, the transition log,
      // the outbox event — all rolled back as if they never happened.
      await connection.rollback();
      throw error;
    } finally {
      // Always return the connection to the pool,
      // whether the operation succeeded or failed.
      // Forgetting this causes connection leaks — the pool
      // runs out of connections, and the service freezes.
      connection.release();
    }
  }
```

The `try/catch/finally` pattern here is critical. The `finally` block ensures the connection is released even when an exception occurs. If you forget `connection.release()`, your application will slowly leak database connections until it cannot open new ones — a debugging nightmare that typically surfaces at 3 AM under peak load.

---

### confirmHold() — Making It Permanent

When payment succeeds, the Booking Service calls `confirmHold()` to convert the temporary hold into a permanent booking:

```typescript
  async confirmHold(holdId: bigint, bookingId: bigint): Promise<void> {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      // Attempt to confirm the hold.
      // Three conditions must ALL be true:
      //   1. The hold must exist (id = ?)
      //   2. The hold must be active (status = 'active')
      //   3. The hold must not have expired (expires_at > NOW())
      const [result] = await connection.execute(`
        UPDATE inventory_holds
        SET status = 'confirmed', booking_id = ?, confirmed_at = NOW()
        WHERE id = ? AND status = 'active' AND expires_at > NOW()
      `, [bookingId, holdId]);

      if (result.affectedRows === 0) {
        // The hold was not active or had expired.
        // The caller must handle this — perhaps by retrying
        // the entire booking flow, or telling the user the
        // room is no longer available.
        throw new InvalidHoldStateError('Hold is not active or has expired');
      }

      // Log the transition for the audit trail.
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
```

Notice the `WHERE status = 'active' AND expires_at > NOW()` condition. This is the state machine enforced at the database level. You cannot confirm an expired hold. You cannot confirm a hold that was already released. If the hold expired while the user was entering their credit card details, the confirmation fails, and the Booking Service must start the process over with a new hold (if inventory is still available).

This is a critical design choice: **the database enforces the state machine, not just the application code**. Even if a bug in the code tries to confirm an expired hold, the SQL `WHERE` clause prevents it.

---

### releaseHold() — Giving Inventory Back

When a user cancels, or a saga compensation step runs, we release the hold and return the inventory to the available pool:

```typescript
  async releaseHold(holdId: bigint, reason: string, releasedBy: string): Promise<void> {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      // Lock the hold row with FOR UPDATE.
      // This prevents two simultaneous release attempts from
      // both succeeding and double-restoring inventory.
      const [holds] = await connection.execute(`
        SELECT resource_type, resource_id, resource_date, quantity, status
        FROM inventory_holds WHERE id = ? FOR UPDATE
      `, [holdId]);

      if (holds.length === 0) throw new NotFoundError('Hold not found');
      if (holds[0].status !== 'active') {
        throw new InvalidHoldStateError(
          `Cannot release hold in status: ${holds[0].status}`
        );
      }

      const hold = holds[0];

      // Mark the hold as released.
      await connection.execute(`
        UPDATE inventory_holds
        SET status = 'released', released_at = NOW(), released_by = ?
        WHERE id = ?
      `, [releasedBy, holdId]);

      // RESTORE the inventory — add the quantity back to available,
      // subtract from reserved.
      await connection.execute(`
        UPDATE inventory
        SET reserved_quantity = reserved_quantity - ?,
            available_quantity = available_quantity + ?, updated_at = NOW()
        WHERE resource_type = ? AND resource_id = ? AND resource_date = ?
      `, [hold.quantity, hold.quantity, hold.resource_type,
          hold.resource_id, hold.resource_date]);

      // Log the transition.
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

Two things to note here. First, the `SELECT ... FOR UPDATE` lock at the top prevents a race condition in the release itself — if two processes try to release the same hold simultaneously, one wins the lock and releases it, and the other gets the lock second but sees `status !== 'active'` and correctly throws an error instead of restoring inventory twice.

Second, the `released_by` parameter records who or what released the hold. This could be `"user:12345"` (the user cancelled), `"saga:booking-9876"` (a saga compensation step), or `"system_cron"` (the cleanup job). This audit trail is how your support team investigates issues.

---

## Expired Holds Cleanup: The Safety Net

What happens to holds that nobody confirms or releases? The user closed their browser tab, their phone died, or they just got distracted. Those holds are sitting in the `active` state, blocking inventory that nobody is going to book. We need a cleanup process.

The system runs a stored procedure **every 30 seconds** that finds all expired holds and restores their inventory:

```sql
-- This procedure runs automatically every 30 seconds via MySQL Event Scheduler.
DELIMITER //

CREATE PROCEDURE release_expired_holds()
BEGIN
    DECLARE v_expired_count INT DEFAULT 0;

    -- Step 1: Collect all expired holds into a temp table.
    -- FOR UPDATE locks these rows so that a concurrent confirmHold()
    -- cannot confirm a hold while we are expiring it.
    CREATE TEMPORARY TABLE IF NOT EXISTS temp_expired_holds (
        hold_id BIGINT, resource_type VARCHAR(20),
        resource_id BIGINT, resource_date DATE,
        quantity SMALLINT, fencing_token BIGINT
    );

    START TRANSACTION;

    INSERT INTO temp_expired_holds
    SELECT id, resource_type, resource_id, resource_date, quantity, fencing_token
    FROM inventory_holds
    WHERE status = 'active' AND expires_at < NOW()
    FOR UPDATE;

    -- Step 2: Mark all expired holds as 'expired'.
    UPDATE inventory_holds
    SET status = 'expired', released_at = NOW(), released_by = 'system_cron'
    WHERE id IN (SELECT hold_id FROM temp_expired_holds);

    SET v_expired_count = ROW_COUNT();

    -- Step 3: Restore inventory for each expired hold.
    -- The fencing token check ensures we only restore inventory
    -- if no newer operation has already modified it.
    UPDATE inventory i
    INNER JOIN temp_expired_holds h ON
        i.resource_type = h.resource_type AND
        i.resource_id = h.resource_id AND
        i.resource_date = h.resource_date
    SET i.reserved_quantity = i.reserved_quantity - h.quantity,
        i.available_quantity = i.available_quantity + h.quantity,
        i.updated_at = NOW()
    WHERE i.fencing_token < h.fencing_token;

    -- Step 4: Record the transition for every expired hold.
    INSERT INTO inventory_hold_transitions
      (hold_id, from_status, to_status, transition_reason, transitioned_by)
    SELECT hold_id, 'active', 'expired',
           'Automatic expiry by cron job', 'system_cron'
    FROM temp_expired_holds;

    COMMIT;

    DROP TEMPORARY TABLE IF EXISTS temp_expired_holds;

    SELECT v_expired_count as expired_holds, NOW() as processed_at;
END//

DELIMITER ;

-- Schedule it to run every 30 seconds automatically.
CREATE EVENT release_expired_holds_event
ON SCHEDULE EVERY 30 SECOND
DO CALL release_expired_holds();
```

The `FOR UPDATE` in Step 1 is crucial. It prevents a timing hazard: without it, a user could confirm their hold at the exact moment the cleanup job is expiring it. The lock ensures only one of them wins. Either the user confirms in time (the cleanup job waits and then sees the hold is no longer `active`), or the cleanup job expires it first (the user's `confirmHold()` fails with "hold is not active or has expired" and they must restart the booking flow).

Notice the fencing token check in Step 3: `WHERE i.fencing_token < h.fencing_token`. This ensures the cleanup job does not restore inventory if a newer operation has already modified it. Even the safety net respects the deli counter.

> **What If You Skip This?** Without automatic hold expiry, abandoned holds permanently reduce your available inventory. A hotel with 100 rooms might show "0 rooms available" even though 30 of the "reserved" rooms are from users who closed their browsers hours ago. You would need manual intervention to un-stick inventory — and by then, you have lost the revenue from legitimate bookings those rooms could have served.

---

## Overbooking Policies: A Business Decision

You might be surprised to learn that some overbooking is intentional. Airlines have done it for decades. The logic is statistical: a predictable percentage of passengers do not show up for their flights. If an airline has 200 seats and a 10% no-show rate, selling 220 tickets means approximately 200 people actually board. The airline fills every seat instead of flying with 20 empty ones.

Our system supports configurable overbooking policies per resource type and class:

```typescript
export const overbookingPolicies = {
  flight: {
    economy: 0.10,      // Allow 10% overbooking for economy seats
    business: 0.05,     // Only 5% for business class (higher-value customers)
    first: 0.00,        // ZERO overbooking for first class
    compensation: {
      voluntary: 400,   // Offer $400 to volunteers who give up their seat
      involuntary: 800  // Pay $800 if you bump someone involuntarily
    }
  },
  hotel: {
    standard: 0.02,     // Allow 2% overbooking for standard rooms
    premium: 0.00,      // No overbooking for premium/suite rooms
    compensation: {
      upgradeSameHotel: true,    // First option: upgrade within the hotel
      alternativeHotel: true,    // Second option: book at a partner hotel
      refundAmount: 1.5          // Pay 1.5x the room rate as compensation
    }
  },
  car: {
    overbookingLimit: 0.00,      // No overbooking for rental cars
    compensation: {
      upgradeCategory: true,     // Upgrade from compact to midsize, etc.
      refundAmount: 2.0          // Pay 2x the daily rate as compensation
    }
  }
};
```

The policy is a **business decision**, not a technical one. The engineering team builds the system to support configurable overbooking limits. The business team decides the actual percentages based on historical no-show data, compensation costs, and risk tolerance. Hotels overbook less than airlines because the cost of walking a guest (finding them another hotel, paying for it, plus compensation) is higher than bumping a flight passenger.

In the inventory check, the overbooking policy adjusts the effective capacity:

```typescript
// Without overbooking:  effective_capacity = total_quantity
// With 10% overbooking: effective_capacity = total_quantity * 1.10
// So a 200-seat economy section can sell up to 220 seats.
```

The `available_quantity` check in `createHold()` uses this effective capacity rather than the raw total. This is a one-line change in the business logic — the entire hold/confirm/release mechanism works identically whether overbooking is enabled or not.

> **Analogy:** Overbooking is like a restaurant taking 22 reservations for 20 tables, knowing from experience that about 2 parties will no-show every night. It maximizes revenue when the prediction is right. When it is wrong (all 22 show up), the restaurant has a compensation plan ready: free drinks, a voucher for next time, or a nearby partner restaurant.

---

## Bringing It All Together: The Full Flow

Let us trace the complete lifecycle of a hotel room hold from creation to confirmation:

```
1. User searches for hotels in Tokyo, March 15-17.
   (Search Service queries Elasticsearch — Chapter 10.)

2. User finds "Tokyo Grand Hotel" with 1 room available and clicks "Book."
   → Frontend calls POST /api/inventory/hold
   → InventoryHoldService.createHold() runs:
     - Gets fencing token #47
     - Checks for existing hold (none found)
     - UPDATEs inventory: available_quantity 1 → 0, reserved_quantity 0 → 1
     - Creates hold record (status: 'active', expires_at: 10 minutes from now)
     - Logs transition: none → active
     - Writes outbox event
     - Commits transaction

3. User enters credit card details. (Hold is active. Clock is ticking.)

4. User clicks "Pay." Booking Service calls Payment Service.
   → Payment succeeds. Transaction ID: TXN-8890.

5. Booking Service calls InventoryHoldService.confirmHold().
   → UPDATEs hold: status 'active' → 'confirmed', booking_id set.
   → Logs transition: active → confirmed.
   → The room is officially booked.

6. Alternatively: User abandons the page and never pays.
   → 10 minutes pass. Hold expires.
   → Cleanup job runs, finds the hold (expires_at < NOW()).
   → UPDATEs hold: status 'active' → 'expired'.
   → Restores inventory: available_quantity 0 → 1.
   → The room goes back on the market.
```

Every path through this flow ends in a consistent state. The room is either booked or available. It is never stuck, never double-sold, never leaked. That is the power of combining the hold pattern, the state machine, fencing tokens, and TTL-based expiry.

---

## Chapter 11 Summary

| Concept | One-Sentence Summary |
|---------|---------------------|
| Race condition | Two concurrent operations read the same state before either writes, leading to conflicting results like double bookings. |
| Hold pattern | Reserve inventory temporarily, then confirm or release — separating the "intent to book" from the "completed booking." |
| State machine | Holds move through defined states (active, confirmed, expired, released, cancelled) with explicit, enforced transitions. |
| Fencing token | A monotonically increasing number that prevents stale or delayed operations from corrupting the current state. |
| Idempotency check | Detecting duplicate requests and extending existing holds instead of creating new ones. |
| Transactional Outbox | Writing events to a database table within the same transaction as business data, ensuring events are published if and only if data changes commit. |
| TTL-based expiry | Holds automatically expire after a set time, freeing inventory for other users via a scheduled cleanup job. |
| Overbooking policies | Configurable business rules that allow selling slightly more than physical capacity, based on statistical no-show rates. |
| FOR UPDATE locking | Pessimistic database locks that prevent concurrent modifications, ensuring only one process can modify a hold at a time. |

> **Checkpoint:** Answer these four questions without scrolling back: (1) What is the race condition in the naive booking approach, and why does it lead to double bookings? (2) What are the five states in the hold state machine, and which ones restore inventory? (3) What is a fencing token and what problem does it solve? (4) What happens to a hold when the user abandons the booking page? If you can explain all four clearly, you understand the most correctness-critical component of our booking system and are ready for Chapter 12.
