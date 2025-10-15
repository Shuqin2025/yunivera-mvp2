const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const shopware = require('../lib/parsers/shopwareParser');
const woocommerce = require('../lib/parsers/woocommerceParser');
const magento = require('../lib/parsers/magentoParser');
const shopify = require('../lib/parsers/shopifyParser');

function checkShape(item) {
  assert.ok('title' in item, 'title');
  assert.ok('url' in item, 'url');
  assert.ok('price' in item, 'price');
  assert.ok('sku' in item, 'sku');
  assert.ok('img' in item || 'imgs' in item, 'image field');
}

test('shopware.parse: 最小卡片', () => {
  const html = `
    <div class="product-box">
      <a href="/p1" class="product-title">Demo P1</a>
      <img src="/p1.jpg" />
      <span class="product-price">9,99 €</span>
    </div>`;
  const $ = cheerio.load(html);
  const list = shopware.parse($, 'https://demo.shop', { limit: 50 });
  assert.equal(list.length, 1);
  checkShape(list[0]);
});

test('woocommerce.parse: 最小卡片', () => {
  const html = `
    <ul class="products">
      <li class="product">
        <a class="woocommerce-LoopProduct-link" href="/p2" title="P2">P2</a>
        <img src="/p2.jpg"/>
        <span class="price">€19,99</span>
      </li>
    </ul>`;
  const $ = cheerio.load(html);
  const list = woocommerce.parse($, 'https://demo.woo', { limit: 50 });
  assert.equal(list.length, 1);
  checkShape(list[0]);
});

test('magento.parse: 最小卡片', () => {
  const html = `
    <ol class="products list items product-items">
      <li class="product-item">
        <a class="product-item-link" href="/p3" title="P3">P3</a>
        <img src="/p3.jpg"/>
        <span class="price">29,99 €</span>
      </li>
    </ol>`;
  const $ = cheerio.load(html);
  const list = magento.parse($, 'https://demo.m2', { limit: 50 });
  assert.equal(list.length, 1);
  checkShape(list[0]);
});

test('shopify.parse: 最小卡片', () => {
  const html = `
    <div class="grid">
      <div class="grid-product product-item">
        <a href="/p4" class="grid-product__link"><span class="product-title">P4</span></a>
        <img src="/p4.jpg"/>
        <span class="price">34,99€</span>
      </div>
    </div>`;
  const $ = cheerio.load(html);
  const list = shopify.parse($, 'https://demo.shopify', { limit: 50 });
  assert.equal(list.length, 1);
  checkShape(list[0]);
});
