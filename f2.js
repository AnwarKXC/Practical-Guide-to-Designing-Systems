var f=require("fs"),p="e:/Global Booking System/enhanced_ch14.md",c=f.readFileSync(p,"utf8");c=c.split("KEY -- UUID").join("KEY, -- UUID");f.writeFileSync(p,c);console.log("ok14")
var f=require("fs"),p="e:/Global Booking System/enhanced_ch15.md",c=f.readFileSync(p,"utf8");c=c.split("KEY -- UUID").join("KEY, -- UUID");f.writeFileSync(p,c);console.log("ok15")
