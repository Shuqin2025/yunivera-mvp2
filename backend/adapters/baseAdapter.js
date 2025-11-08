// backend/adapters/baseAdapter.js
export default class BaseAdapter {
  constructor($) {
    this.$ = $;
  }

  parseItem(el) {
    return {
      name: this.$(el).find('.title').text(),
      image: this.$(el).find('img').attr('src'),
      price: parseFloat(this.$(el).find('.price').text().replace('€', '').trim()),
    };
  }

  parseAll() {
    return this.$('.product').map((i, el) => this.parseItem(el)).get();
  }
}
