import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class SiteToSiteVpnStack extends Stack {
  private vpc: ec2.Vpc;
  private subnetPrivateA: ec2.ISubnet;
  private subnetPrivateB: ec2.ISubnet;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.vpcAndTGWSetup();
    this.instancesSetup();
  }

  private vpcAndTGWSetup() {
    this.vpc = new ec2.Vpc(this, 'aws_vpc', {
      cidr: '10.16.0.0/16',
      enableDnsSupport: true,
      enableDnsHostnames: true,
      subnetConfiguration: []
    });
    Tags.of(this.vpc).add('Name', 'A4L-AWS');

    const customRouteTable = new ec2.CfnRouteTable(this, 'CustomRT', {
      vpcId: this.vpc.vpcId
    });
    Tags.of(customRouteTable).add('Name', 'A4L-AWS-RT');

    const azSubnetA = this.availabilityZones[0];
    const subnetPrivateA = new ec2.CfnSubnet(this, 'PrivateA', {
      vpcId: this.vpc.vpcId,
      availabilityZone: azSubnetA,
      cidrBlock: '10.16.32.0/20'
    });
    Tags.of(subnetPrivateA).add('Name', 'sn-aws-private-A');

    const routeTableAssociationPrivateA = new ec2.CfnSubnetRouteTableAssociation(this, 'SubnetAssociationPrivateA', {
      subnetId: subnetPrivateA.attrSubnetId,
      routeTableId: customRouteTable.ref
    });

    this.subnetPrivateA = ec2.Subnet.fromSubnetAttributes(this, 'importedPrivateA', {
      subnetId: subnetPrivateA.attrSubnetId,
      routeTableId: customRouteTable.attrRouteTableId,
      availabilityZone: azSubnetA
    });

    const azSubnetB = this.availabilityZones[1];
    const subnetPrivateB = new ec2.CfnSubnet(this, 'PrivateB', {
      vpcId: this.vpc.vpcId,
      availabilityZone: azSubnetB,
      cidrBlock: '10.16.96.0/20',
    });
    Tags.of(subnetPrivateB).add('Name', 'sn-aws-private-B');

    const routeTableAssociationPrivateB = new ec2.CfnSubnetRouteTableAssociation(this, 'SubnetAssociationPrivateB', {
      subnetId: subnetPrivateB.attrSubnetId,
      routeTableId: customRouteTable.ref
    });

    this.subnetPrivateB = ec2.Subnet.fromSubnetAttributes(this, 'importedPrivateB', {
      subnetId: subnetPrivateB.attrSubnetId,
      routeTableId: customRouteTable.attrRouteTableId,
      availabilityZone: azSubnetB
    });

    const transitGateway = new ec2.CfnTransitGateway(this, 'TransitGateway', {
      amazonSideAsn: 64512,
      description: 'A4LTGW',
      defaultRouteTableAssociation: 'enable',
      dnsSupport: 'enable',
      vpnEcmpSupport: 'enable'
    });

    const transitGatewayAttachment = new ec2.CfnTransitGatewayAttachment(this, 'TGWAttachment', {
      subnetIds: [subnetPrivateA.attrSubnetId, subnetPrivateB.attrSubnetId],
      transitGatewayId: transitGateway.attrId,
      vpcId: this.vpc.vpcId
    });
    Tags.of(transitGatewayAttachment).add('Name', 'A4LTGWATTACHMENT');

    const transitGatewayDefaultRoute = new ec2.CfnRoute(this, 'TGWDefaultRoute', {
      transitGatewayId: transitGateway.attrId,
      routeTableId: customRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0'
    }).addDependsOn(transitGatewayAttachment);
  }

  private instancesSetup() {
    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: this.vpc,
      description: 'Default A4L AWS SG'
    });

    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH IPv4 IN');
    securityGroup.addIngressRule(ec2.Peer.ipv4('192.168.8.0/21'), ec2.Port.allTraffic(), 'Allow ALL from ONPREM Networks');

    const securityGroupIngress = new ec2.CfnSecurityGroupIngress(this, 'SecurityGroupIngress', {
      groupId: securityGroup.securityGroupId,
      ipProtocol: '-1',
      sourceSecurityGroupId: securityGroup.securityGroupId,
      description: 'Allow porters of this security group to access other resources using the same SG under any protocol.'
    });

    const ec2PolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:DescribeAssociation',
        'ssm:GetDeployablePatchSnapshotForInstance',
        'ssm:GetDocument',
        'ssm:DescribeDocument',
        'ssm:GetManifest',
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:ListAssociations',
        'ssm:ListInstanceAssociations',
        'ssm:PutInventory',
        'ssm:PutComplianceItems',
        'ssm:PutConfigurePackageResult',
        'ssm:UpdateAssociationStatus',
        'ssm:UpdateInstanceAssociationStatus',
        'ssm:UpdateInstanceInformation',
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
        'ec2messages:AcknowledgeMessage',
        'ec2messages:DeleteMessage',
        'ec2messages:FailMessage',
        'ec2messages:GetEndpoint',
        'ec2messages:GetMessages',
        'ec2messages:SendReply',
        's3:*',
        'sns:*'
    ],
      resources: ['*']
    });

    const ec2Policy = new iam.Policy(this, 'Ec2Policy', {policyName: 'root'});
    ec2Policy.addStatements(ec2PolicyStatement);

    const principal = new iam.ServicePrincipal('ec2.amazonaws.com');
    const ec2Role = new iam.Role(this, 'Ec2Role', {
      assumedBy: principal,
      path: '/',
    });
    ec2Role.grant(principal, 'sts:AssumeRole');
    ec2Policy.attachToRole(ec2Role);

    const ssmInterfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ssmEndpoint', {
      vpc: this.vpc,
      service: new ec2.InterfaceVpcEndpointAwsService(`com.amazonaws.${this.region}.ssm`),
      privateDnsEnabled: true,
      subnets: {
        subnets: [this.subnetPrivateA, this.subnetPrivateB]
      },
      securityGroups: [securityGroup]
    });

    const ssmEc2MessagesInterfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ssmEc2MessagesEndpoint', {
      vpc: this.vpc,
      service: new ec2.InterfaceVpcEndpointAwsService(`com.amazonaws.${this.region}.ec2messages`),
      privateDnsEnabled: true,
      subnets: {
        subnets: [this.subnetPrivateA, this.subnetPrivateB]
      },
      securityGroups: [securityGroup]
    });

    const ssmMessagesInterfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ssmMessagesEndpoint', {
      vpc: this.vpc,
      service: new ec2.InterfaceVpcEndpointAwsService(`com.amazonaws.${this.region}.ssmmessages`),
      privateDnsEnabled: true,
      subnets: {
        subnets: [this.subnetPrivateA, this.subnetPrivateB]
      },
      securityGroups: [securityGroup]
    });

    const ec2A = new ec2.Instance(this, 'EC2A', {
      vpc: this.vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux(),
      vpcSubnets: {
        subnets: [this.subnetPrivateA]
      },
      securityGroup,
      role: ec2Role
    });
    ec2A.node.addDependency(ssmInterfaceEndpoint, ssmEc2MessagesInterfaceEndpoint, ssmMessagesInterfaceEndpoint);
    Tags.of(ec2A).add('Name', 'AWS-EC2-A');

    const ec2B = new ec2.Instance(this, 'EC2B', {
      vpc: this.vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux(),
      vpcSubnets: {
        subnets: [this.subnetPrivateB]
      },
      securityGroup,
      role: ec2Role
    });
    ec2B.node.addDependency(ssmInterfaceEndpoint, ssmEc2MessagesInterfaceEndpoint, ssmMessagesInterfaceEndpoint);
    Tags.of(ec2B).add('Name', 'AWS-EC2-B');
  }
}
