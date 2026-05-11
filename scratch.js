const { JSDOM } = require("jsdom");
const dom = new JSDOM(`
<select id="myselect">
  <option value="" selected="selected">Choose</option>
  <option value="1">Yes</option>
  <option value="0">No</option>
</select>
`);

const select = dom.window.document.getElementById("myselect");
const value = "No";
const valLower = value.toLowerCase().trim();

let matchingOptionIndex = -1;
for (let i = 0; i < select.options.length; i++) {
  const opt = select.options[i];
  const optText = opt.text.toLowerCase().trim();
  const optValue = opt.value.toLowerCase().trim();
  const optId = (opt.id || '').toLowerCase().trim();
  const optLabel = (opt.label || '').toLowerCase().trim();
  const optDataValue = (opt.getAttribute('data-value') || '').toLowerCase().trim();

  const isPlaceholderOpt = optValue === '' || optValue === 'none' || optValue === 'null' ||
    optValue === 'select' || optValue === '-1' ||
    optText === '' ||
    optText.includes('select') || optText.includes('choose') ||
    optText.includes('option') || optText.includes('please');

  console.log(`i=${i}, optText="${optText}", optValue="${optValue}", isPlaceholderOpt=${isPlaceholderOpt}`);

  if (isPlaceholderOpt) continue;

  if (optText === valLower || optValue === valLower ||
    optId === valLower || optLabel === valLower || optDataValue === valLower) {
    matchingOptionIndex = i;
    console.log(`Matched exactly at index ${i}`);
    break;
  }
}
console.log(`Result: ${matchingOptionIndex}`);
