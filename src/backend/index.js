exports.handler =  async function(event, context) {
    console.log("EVENT: \n" + JSON.stringify(event, null, 2))
    return {
        "isBase64Encoded": false,
        "statusCode": 200,
        "statusDescription": "200 OK",
        "headers": {
            "Set-cookie": "cookies",
            "Content-Type": "application/text",
            // This should be restricted to your domain, and nothing more. This is only for demonstration purposes
            "Access-Control-Allow-Origin": "*"
        },
        "body": "42"
    }
}
  