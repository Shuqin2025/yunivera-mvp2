\# Excel Catalog Schema v1.1



\## Overview



`Excel Catalog Schema v1.1` defines the structured export format used by the Yunivera Smart Catalog Generator.



The schema standardizes the product catalog table generated from directory pages and ensures compatibility with:



\- directory extraction

\- semantic schema registry

\- runtime manifest

\- governance trace

\- governance report generation



The schema is designed to support both:



1\. \*\*Business-readable product catalogs\*\*

2\. \*\*Governance-aware structured outputs\*\*



This schema is used by the Excel export pipeline:

Directory URL

↓

Catalog Parser

↓

Product JSON

↓

Excel Builder

↓

catalog.xlsx



---



\# Column Order (Fixed)



The column order \*\*must remain stable\*\* to avoid breaking UI layout, Excel export logic, and existing adapters.

1. row\_index



2\. sku



3\. image



4\. description



5\. moq



6\. price



7\. product\_url





Displayed in the UI as:





货号 / SKU

图片 / Image

描述 / Description

起订量 / MOQ

单价 / Price

链接 / Product URL



---



\# Field Specifications



---



\## 1. row\_index



Display Names



CN: `#`  

EN: `#`  

DE: `#`



Type

integer

Required

yes



Description



Row index used for display ordering in the Excel table.



Governance Role

display\_only





Notes



\- Not part of semantic schema

\- Not used in governance rules

\- Not stored in manifest



---



\## 2. sku



Display Names



CN: `货号`  

EN: `SKU`  

DE: `Artikelnummer`



Type





string





Required





recommended





Description



Product identifier used for catalog indexing and product reference.



Possible Source Fields





sku

product\_code

item\_number

article\_number

model\_code





Semantic Role





canonical identifier





Governance Notes



Missing SKU may trigger governance rules such as:





G-MISSING-SKU





Possible action:





require\_review





---



\## 3. image



Display Names



CN: `图片`  

EN: `Image`  

DE: `Bild`



Type





string (URL)





Required





optional





Description



Primary product image URL.



Possible Source Fields





image

image\_url

thumbnail

src





Governance Notes



Image absence does not block export but may be recorded in trace artifacts.



---



\## 4. description



Display Names



CN: `描述`  

EN: `Description`  

DE: `Beschreibung`



Type





string





Required





yes





Description



Human-readable product description.  

Usually composed of the product title and key descriptive elements.



Possible Source Fields





title

name

product\_name

description

summary





Semantic Role





primary human-readable field





Governance Notes



Missing description may trigger validation rules.



---



\## 5. moq



Display Names



CN: `起订量`  

EN: `MOQ`  

DE: `Mindestmenge`



Type





integer | string





Required





optional





Description



Minimum order quantity required by the supplier.



Possible Source Fields





moq

min\_qty

minimum\_order\_quantity





Notes



If unavailable, display:





—





---



\## 6. price



Display Names



CN: `单价`  

EN: `Price`  

DE: `Preis`



Type





number | formatted string





Required





recommended





Description



Product unit price.



Displayed in Excel as formatted text:





11,19 €

5.99 EUR





Recommended internal structure:





{

"amount": 11.19,

"currency": "EUR"

}





Possible Source Fields





price

amount

unit\_price

price.amount





Governance Notes



Price validation rules may include:





R-PRICE-NUMERIC

R-PRICE-POSITIVE





---



\## 7. product\_url



Display Names



CN: `链接`  

EN: `Product URL`  

DE: `Link`



Type





string (URL)





Required





yes





Description



Link to the product detail page.



Possible Source Fields





href

product\_url

link

canonical\_url





Semantic Role





source reference





Governance Notes



This field is used for:



\- audit traceability

\- manifest evidence

\- governance reporting



---



\# Mapping to Semantic Schema Registry



| Excel Column | Semantic Field |

|---------------|----------------|

| sku | sku |

| image | image |

| description | product\_name / summary |

| moq | moq |

| price | price.amount / price.currency |

| product\_url | url |



---



\# Governance Relevance



Fields with strong governance importance:





sku

description

price

product\_url





Fields with moderate importance:





image

moq





Fields excluded from governance logic:





row\_index





---



\# Version





Excel Catalog Schema v1.1





Used by:





Yunivera Smart Catalog Generator

SSGE Demo Pipeline





---



\# Status





Stable

Recommended for Demo and Production Export





---



\# Notes



This schema provides the business-facing export format for catalog generation while remaining compatible with the internal governance architecture.



Future schema versions may extend support for:



\- brand

\- category

\- availability

\- multi-currency pricing

\- supplier identifiers



