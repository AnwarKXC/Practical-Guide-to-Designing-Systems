var fs=require("fs");
var F=["e:/Global Booking System/enhanced_ch14.md","e:/Global Booking System/enhanced_ch15.md"];
F.forEach(function(f){var c=fs.readFileSync(f,"utf8");c=c.replace(/PRIMARY KEY -- UUID/g,"PRIMARY KEY, -- UUID");fs.writeFileSync(f,c);console.log("Fixed: "+f)});
